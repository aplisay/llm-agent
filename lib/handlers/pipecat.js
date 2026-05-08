const {
  PIPECAT_WORKER_URL,
  PIPECAT_DISPATCH_TOKEN,
  PIPECAT_JOIN_SECRET,
  PIPECAT_PUBLIC_URL,
} = process.env;

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import defaultLogger from '../logger.js';
import Handler from './handler.js';
import PipecatModel from '../models/pipecat.js';
import { Call } from '../database.js';
import { AgentConcurrencyLimitExceededError } from '../concurrency/agent-concurrency-limits.js';

/**
 * Pipecat handler. Replicates the contract documented in
 * docs/livekit-agent-architecture.md but talks to a self-contained Pipecat worker
 * over HTTP instead of LiveKit's AgentDispatchClient. The worker uses Daily as a
 * pure SIP gateway for telephony and SmallWebRTCTransport for browser clients;
 * the gateway is abstracted in the worker so it can be swapped (e.g. FreeSWITCH)
 * without touching this handler.
 */
class Pipecat extends Handler {
  static name = 'pipecat';
  static description = 'Pipecat';

  // Required for new handlers per section 5.5 of the architecture doc.
  static hasDynamicMetadata = true;
  static hasWebRTC = true;
  static hasTelephony = true;
  static hasTransfer = true;

  static get models() {
    return [PipecatModel];
  }

  static needKey = {
    PIPECAT_WORKER_URL,
    PIPECAT_DISPATCH_TOKEN,
    PIPECAT_JOIN_SECRET,
    PIPECAT_PUBLIC_URL,
  };

  // Voice catalog mirrors the LiveKit handler's surface: realtime providers expose
  // their built-in voices; pipeline TTS voices come from the platform's Voices index
  // via the base class default. Keep this minimal until pipeline-mode voice picking
  // is exercised end-to-end.
  static voices = (async () => ({
    OpenAI: {
      any: [
        { name: 'alloy', description: 'Alloy', gender: 'female' },
        { name: 'ash', description: 'Ash', gender: 'male' },
        { name: 'ballad', description: 'Ballad', gender: 'male' },
        { name: 'coral', description: 'Coral', gender: 'female' },
        { name: 'echo', description: 'Echo', gender: 'female' },
        { name: 'fable', description: 'Fable - transatlantic', gender: 'female' },
        { name: 'onyx', description: 'Onyx', gender: 'male' },
        { name: 'nova', description: 'Nova', gender: 'female' },
        { name: 'sage', description: 'Sage', gender: 'female' },
        { name: 'shimmer', description: 'Shimmer', gender: 'female' },
        { name: 'verse', description: 'Verse', gender: 'female' },
      ],
    },
  }))();

  /**
   * Outbound dispatch entry point — section 2.4 of the architecture doc.
   *
   * Reserves the agent concurrency slot (via call.start) before dispatching, so the
   * HTTP originator gets the busy/429 immediately. On dispatch failure the slot is
   * released by ending the call with an error reason.
   */
  static async outbound({ instance, callerId, calledId, metadata, aplisayId }) {
    const logger = defaultLogger;
    const { id: instanceId } = instance;

    logger.debug(
      { instanceId, callerId, calledId, metadata },
      'originating outbound Pipecat call',
    );

    let call;
    try {
      const callId = uuidv4();
      const sessionId = `outbound-${callId}-${Date.now()}`;

      call = await Call.create({
        id: callId,
        userId: instance.userId,
        organisationId: instance.organisationId,
        instanceId: instance.id,
        agentId: instance.agentId,
        platform: 'pipecat',
        platformCallId: sessionId,
        calledId,
        callerId,
        modelName: instance.Agent?.modelName,
        options: { outbound: true },
        metadata: {
          ...(metadata || {}),
          aplisayId,
          outbound: true,
        },
      });

      try {
        await call.start({
          instance,
          user: instance.User,
          organisation: instance.Organisation,
        });
      } catch (e) {
        // call.start() updates call.status on concurrency failure; let it propagate.
        throw e;
      }

      const dispatchResult = await Pipecat.dispatchToWorker({
        kind: 'outbound',
        sessionId,
        callId,
        callerId,
        calledId,
        instanceId,
        aplisayId,
        callMetadata: metadata,
      });

      logger.debug({ dispatchResult, sessionId }, 'Pipecat worker dispatched for outbound call');

      return {
        success: true,
        callId,
        sessionId,
        dispatchResult,
      };
    } catch (error) {
      logger.error(
        { error, instanceId, callerId, calledId },
        'Failed to originate outbound Pipecat call',
      );
      if (error instanceof AgentConcurrencyLimitExceededError) {
        throw error;
      }
      if (call) {
        await call.end(`Outbound call origination failed: ${error.message}`).catch(() => {});
      }
      throw new Error(`Outbound call origination failed: ${error.message}`);
    }
  }

  /**
   * Non-SIP credentialed join — section 2.5 of the architecture doc.
   *
   * Returns credentials wrapped in a `{ pipecat: ... }` namespace key per the
   * polymorphic listener-endpoint contract. The credentials let a browser client
   * negotiate a peer-to-peer WebRTC session directly with the Pipecat worker via
   * SmallWebRTCTransport.
   */
  async join() {
    const { logger, instance: { id: instanceId } } = this;
    logger.debug({ instanceId }, 'minting Pipecat join credentials');
    try {
      if (!PIPECAT_PUBLIC_URL) throw new Error('PIPECAT_PUBLIC_URL is not defined');
      if (!PIPECAT_JOIN_SECRET) throw new Error('PIPECAT_JOIN_SECRET is not defined');

      const sessionId = `join-${instanceId}-${Date.now()}`;
      // Short-lived (5 minute) join token authenticating the browser to the
      // worker's WebRTC offer endpoint.
      const expiresAt = Math.floor(Date.now() / 1000) + 5 * 60;
      const payload = JSON.stringify({ instanceId, sessionId, expiresAt });
      const signature = crypto
        .createHmac('sha256', PIPECAT_JOIN_SECRET)
        .update(payload)
        .digest('base64url');
      const token = `${Buffer.from(payload).toString('base64url')}.${signature}`;

      const offerUrl = `${PIPECAT_PUBLIC_URL.replace(/\/$/, '')}/webrtc/offer`;

      const pipecat = {
        offerUrl,
        sessionId,
        token,
        instanceId,
        // ICE servers are returned by the worker on POST /webrtc/offer; clients
        // do not need them up front.
      };
      logger.debug({ pipecat }, 'pipecat join credentials minted');
      return { pipecat };
    } catch (error) {
      logger.error({ error }, error.message);
      throw new Error(`Call setup: ${error.message}`);
    }
  }

  /**
   * POST a dispatch request to the worker. The worker authenticates the request
   * via the shared bearer token from PIPECAT_DISPATCH_TOKEN.
   */
  static async dispatchToWorker(payload) {
    const url = `${PIPECAT_WORKER_URL.replace(/\/$/, '')}/dispatch`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${PIPECAT_DISPATCH_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Pipecat worker dispatch failed: ${res.status} ${body}`);
    }
    return res.json().catch(() => ({}));
  }

  async destroy() {
    const { logger, agent, instance } = this;
    logger.debug({ instanceId: instance?.id }, 'pipecat call ending');
    try {
      instance && (await instance.destroy({ logging: logger.debug }));
      agent && (await agent.destroy({ logging: logger.debug }));
    } catch (error) {
      logger.error({ error }, error.message);
      throw new Error(`Pipecat teardown: ${error.message}`);
    }
  }
}

export default Pipecat;
