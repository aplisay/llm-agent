// External dependencies
import dotenv from "dotenv";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  type JobContext,
  defineAgent,
  getJobContext,
  telemetry,
  voice,
} from "@livekit/agents";

// Internal modules
import logger from "./logger.js";
import { invocationLogs } from "./invocation-log-buffer.js";
import { bridgeParticipant, chargeableOutboundTrunkId } from "./telephony.js";
import {
  getInstanceById,
  createCall,
  createTransactionLog,
  type Instance,
  type Agent,
  type Call,
  type CallMetadata,
  type OutboundInfo,
  getPhoneEndpointById,
  getPhoneEndpointByNumber,
  type PhoneNumberInfo,
  type PhoneRegistrationInfo,
  type TrunkInfo,
  endCallById,
  getAgentById,
} from "./api-client.js";
import {
  handleTransfer,
  type TransferContext,
  destroyInProgressTransfer,
} from "./transfer-handler.js";
import type { BridgedTakeoverRuntime } from "./bridged-transfer-to-agent.js";
import { withTimeout } from "./utils.js";
import { sipAttribute } from "./sip-attributes.js";
import {
  ConfidenceTonePlayer,
  toneConfigFromOptions,
} from "./confidence-tone.js";
import { DISCONNECT_REASONS, getRoomService } from "./livekit-constants.js";
import { deleteRoomWithRetry } from "./livekit-helpers.js";
import { runAgentWorker } from "./voice-agent-runtime.js";
import { runFallbackMessage } from "./fallback-message.js";
import { userOwnsRow } from "./scope.js";

// Types
import type { RemoteParticipant, Room } from "@livekit/rtc-node";
import { RoomEvent } from "@livekit/rtc-node";
import type { ParticipantInfo, SipParticipant } from "./types.js";
import type {
  CallScenario,
  JobMetadata,
  SetupCallParams,
  TransferArgs,
  MessageData,
  HangupResult,
  HangupExecutor,
} from "./types.js";

dotenv.config();
// LiveKit / plugins may read either name; do not overwrite a set ELEVEN_API_KEY.
if (!process.env.ELEVEN_API_KEY && process.env.ELEVENLABS_API_KEY) {
  process.env.ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
}
if (!process.env.ELEVENLABS_API_KEY && process.env.ELEVEN_API_KEY) {
  process.env.ELEVENLABS_API_KEY = process.env.ELEVEN_API_KEY;
}


Error.stackTraceLimit = 40;
function pinoLogExporter(): void {
  const Exporter = (
    telemetry as {
      PinoCloudExporter?: { prototype: { flush: () => Promise<void> } };
    }
  ).PinoCloudExporter;
  logger.debug(
    { invocationLogs },
    "pinoLogExporter: initializing invocation logs buffer",
  );
  if (!Exporter?.prototype?.flush) return;
  logger.debug(
    { Exporter },
    "pinoLogExporter: initialized pino cloud exporter flush function",
  );
  Exporter.prototype.flush = async function (this: {
    flush: () => Promise<void>;
  }) {
    const self = this as unknown as {
      flushTimer: NodeJS.Timeout | null;
      pendingLogs: unknown[];
      sendLogs: (r: unknown[]) => Promise<void>;
    };
    if (self.flushTimer) {
      clearTimeout(self.flushTimer);
      self.flushTimer = null;
    }
    if (self.pendingLogs.length === 0) return;
    const logs = self.pendingLogs;
    self.pendingLogs = [];
    try {
      invocationLogs.push(...logs);
    } catch (e) {
      logger.warn(
        { error: e },
        "failed to buffer invocation logs from pino exporter",
      );
    }
    logger.debug(
      { length: invocationLogs.length },
      "pinoLogExporter: flushing combined invocation logs",
    );
  };
}
pinoLogExporter();

Error.stackTraceLimit = 40;

/**
 * Entry point for the Livekit agent, provides a function that takes a context object and starts the agent
 *
 *
 * @param ctx - The context object
 * @returns A promise that resolves when the agent is started
 */

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const job = ctx.job;
    const room = job.room as unknown as Room;
    logger.info({ ctx, job, room }, "new call");

    // Simulate standard Agents job environment so RecorderIO can write audio.ogg.
    // The SDK reads sessionDirectory from getJobContext().sessionDirectory (getter backed by _sessionDirectory).
    // Ensure that directory exists on disk and the SDK sees it so RecorderIO.start() runs and can write.
    const jobCtx = getJobContext() as JobContext & {
      sessionDirectory?: string;
      _sessionDirectory?: string;
    };
    let sessionDir: string | undefined =
      jobCtx.sessionDirectory ??
      (jobCtx as { _sessionDirectory?: string })._sessionDirectory;
    if (!sessionDir) {
      try {
        const baseTmp = process.env.TMPDIR || os.tmpdir();
        sessionDir = await fs.mkdtemp(path.join(baseTmp, "livekit-job-"));
        (jobCtx as { _sessionDirectory?: string })._sessionDirectory =
          sessionDir;
        logger.info(
          { sessionDirectory: sessionDir },
          "created fallback session directory for RecorderIO",
        );
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger.warn(
          { error, message: error.message },
          "failed to create fallback session directory; RecorderIO recordings may not be persisted",
        );
      }
    }
    if (sessionDir) {
      try {
        await fs.mkdir(sessionDir, { recursive: true });
      } catch (e) {
        logger.warn(
          { sessionDirectory: sessionDir, error: e },
          "failed to ensure session directory exists on disk",
        );
      }
      logger.info(
        { sessionDirectory: sessionDir },
        "[RecorderIO debug] sessionDirectory set for SDK; RecorderIO only runs if @livekit/agents@1.0.25+ (check node_modules/@livekit/agents/package.json)",
      );
    }

    // Local mutable state used across helpers
    let session: voice.AgentSession | null = null;
    let model: voice.Agent | null = null;
    let bridgedParticipant: SipParticipant | null = null;
    let consultInProgress = false;
    let deafenedTrackSids: string[] = [];
    let mutedTrackSids: string[] = [];
    let b2buaIp: string | null = null;
    let b2buaTransport: string | null = null;
    // Capture B2BUA gateway values for use in onTransfer closure
    let capturedB2buaIp: string | null = null;
    let capturedB2buaTransport: string | null = null;
    // Function to end transfer activity - will be set by setupCallAndUtilities
    let endTransferActivityIfNeeded:
      | ((reason: string) => Promise<void>)
      | null = null;
    // Reference to the call row so the outer catch can mark it failed (with the
    // error reason) if setup throws. Without this a setup failure (e.g. an
    // unusable TTS vendor) leaves an orphaned call with no endedAt/reason and
    // nothing for the diagnosis loop to read.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let recordedCall: any = null;

    try {
      const tGetCallInfo = Date.now();
      const scenario = await getCallInfo(ctx, room);
      logger.info(
        { ms: Date.now() - tGetCallInfo, room: room?.name },
        "timing: getCallInfo done",
      );
      logger.info({ scenario }, "scenario");

      let {
        instance,
        agent,
        participant,
        existingBridge,
        callerId,
        calledId,
        aplisayId,
        callId,
        callMetadata,
        outboundCall,
        outboundInfo,
        registrationOriginated,
        trunkInfo,
        registrationRegistrar,
        registrationTransport,
        registrationUsername,
        registrationEndpointId,
        b2buaGatewayIp = null,
        b2buaGatewayTransport = null,
        aLegEncrypted = true,
        forceBridged,
        sipHeaders = {},
      } = scenario;

      // Store B2BUA gateway info for use in onTransfer closure
      b2buaIp = b2buaGatewayIp || null;
      b2buaTransport = b2buaGatewayTransport || null;
      // Capture values for onTransfer closure
      capturedB2buaIp = b2buaIp;
      capturedB2buaTransport = b2buaTransport;

      if (!agent) {
        throw new Error("Agent is required but not found");
      }

      // If the room already has a bridged participant, we don't want to get involved in it
      //  but we must wait for it to finish before throwing an error or we will clear down the call.
      if (existingBridge) {
        let reason = await waitForExistingBridgedParticipant(
          ctx,
          room,
          existingBridge,
        );
        throw new Error(`Bridged call already existed: ${reason}, ended call`);
      }

      const { userId, modelName, organisationId, options = {} } = agent;

      const {
        call,
        metadata,
        sendMessage,
        onHangup,
        onTransfer,
        checkForHangup,
        sessionRef,
        modelRef,
        getActiveCall,
        setActiveAgentCall,
        endTransferActivityIfNeeded: endTransferActivityFn,
        getTransferState,
        startHandoverTone,
        stopHandoverTone,
        registerBridgedTakeover,
        registerHangupExecutor,
      } = await setupCallAndUtilities({
        ctx,
        room,
        instance,
        agent,
        callerId,
        calledId,
        aplisayId,
        callId,
        callMetadata,
        userId,
        organisationId,
        modelName,
        options,
        modelRef: (create: voice.Agent | null): voice.Agent | null => {
          // Placeholder; actual model instance is set later in runAgentWorker
          create && (model = create);
          return model;
        },
        sessionRef: (
          create: voice.AgentSession | null,
        ): voice.AgentSession | null => {
          create && (session = create);
          return session;
        },
        setBridgedParticipant: (p) => (bridgedParticipant = p),
        setConsultInProgress: (v: boolean) => (consultInProgress = v),
        getConsultInProgress: () => consultInProgress,
        outbound: outboundCall,
        registrationOriginated,
        trunkInfo,
        registrationRegistrar,
        registrationTransport,
        registrationUsername,
        registrationEndpointId,
        b2buaGatewayIp: capturedB2buaIp,
        b2buaGatewayTransport: capturedB2buaTransport,
        aLegEncrypted,
        forceBridged,
        sipHeaders,
        requestHangup: () => {},
        participant: participant,
      });
      recordedCall = call; // so the outer catch can mark it failed on a setup error

      if (outboundCall && outboundInfo && !participant) {
        try {
          logger.info(
            {
              room,
              callerId,
              calledId,
              instanceId: outboundInfo.instanceId,
              aplisayId,
            },
            "bridging participant",
          );
          participant = await bridgeParticipant(
            room.name!,
            outboundInfo.toNumber,
            outboundInfo.aplisayId ?? "",
            outboundInfo.fromNumber,
            callerId || "unknown",
            registrationOriginated,
            b2buaGatewayIp,
            b2buaGatewayTransport,
            registrationEndpointId,
            call?.id,
            aLegEncrypted,
            registrationUsername,
          );
          if (!participant) {
            throw new Error("Outbound call failed to create participant");
          }
        } catch (err) {
          const failureReason = (err as Error).message.replace(
            /^twirp [^:]*: /,
            "",
          );
          logger.error({ err, failureReason }, "Outbound call failed");
          // Notify listeners in-room about the failure
          sendMessage({
            call_failed: failureReason,
          });
          // For failed outbound calls we still want to emit
          // a call start and end so downstream systems see a
          // complete call lifecycle with a clearing reason.
          try {
            const failureTimestamp = new Date();
            // Best effort: log an immediate start then end. The
            // timestamps will be near-identical and represent a
            // call that failed to connect.
            await call.start();
            await call.end(`Outbound call failed: ${failureReason}`);
            logger.info(
              {
                callId: call.id,
                failureReason,
                failureTimestamp,
              },
              "Logged start and immediate end for failed outbound call",
            );
          } catch (loggingError) {
            logger.error(
              { loggingError, failureReason, callId: call?.id },
              "Failed to log start/end for failed outbound call",
            );
          }
          throw err;
        }
      }

      // Record the appropriate transaction at the top level
      sendMessage({ answer: callerId });

      /**
       * Fallback loop around the core agent worker.
       *
       * Behaviour:
       *  - First attempt runs with the primary modelName from the agent.
       *  - On setup/timeout error from runAgentWorker (i.e. before call.start),
       *    we consult the current agent's options.fallback with precedence:
       *      1. fallback.agent   – fetch and substitute a different agent, then retry.
       *      2. fallback.model   – retry the same agent with a different modelName.
       *      3. fallback.message – play a fixed TTS announcement at the caller.
       *      4. fallback.number  – perform a blind transfer to this number and exit.
       *
       * Once we have switched to a fallback agent, any further fallback decisions are
       * controlled by that agent's own options.fallback.
       *
       * Concurrency rejections enter this chain at step 3 (see the catch block):
       * retrying a different agent or model cannot help, but an announcement is
       * exactly what a caller who arrived at a full system should hear.
       */
      let activeAgent = agent;
      let activeModelName = modelName;
      let usedFallbackModel = false;
      let usedFallbackAgent = false;

      // Try primary and any configured model/agent fallbacks until we either succeed
      // or exhaust the configured options and fall back to a transfer/propagated error.
      fallbackLoop: while (true) {
        const fallbackConfig = activeAgent.options?.fallback;

        const activeRecordingOptions =
          instance.recording ?? activeAgent.options?.recording;

        try {
          await runAgentWorker({
            ctx,
            room,
            agent: activeAgent,
            participant,
            callerId,
            calledId,
            modelName: activeModelName,
            metadata,
            sendMessage,
            call,
            onHangup,
            onTransfer,
            modelRef,
            sessionRef,
            getBridgedParticipant: () => bridgedParticipant,
            setBridgedParticipant: (p) => (bridgedParticipant = p),
            checkForHangup,
            getConsultInProgress: () => consultInProgress,
            getActiveCall,
            setActiveAgentCall,
            startHandoverTone,
            stopHandoverTone,
            registerBridgedTakeover,
            registerHangupExecutor,
            endTransferActivityIfNeeded: endTransferActivityFn,
            getTransferState,
            recordingOptions: activeRecordingOptions,
          });
          // Successful run – break out of fallback loop
          break fallbackLoop;
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          // A concurrency rejection is not a fault we can retry around: the limit
          // is enforced in Call.start() regardless of which agent or model is
          // behind it, so fallback.agent and fallback.model would spend setup
          // time only to be refused identically, and fallback.number's
          // transfer-only path calls Call.start() too. Only the fixed message
          // can actually serve a caller who arrived at a full system, because it
          // plays from cache without starting a call at all — so `busy` skips
          // straight to step 3 and, failing that, rethrows so LiveKit still
          // signals busy rather than answering and dropping.
          const busy =
            (error as any)?.code === "AGENT_CONCURRENCY_LIMIT_EXCEEDED";
          logger.error(
            { error, message: error.message, busy, fallbackConfig },
            "runAgentWorker failed, evaluating fallback options",
          );

          // If there is no fallback configuration on the current agent, propagate the error
          if (!fallbackConfig) {
            throw error;
          }

          // 1. Agent-level fallback: fetch and substitute a different agent
          if (
            !busy &&
            !usedFallbackAgent &&
            fallbackConfig.agent &&
            fallbackConfig.agent !== activeAgent.id
          ) {
            try {
              logger.info(
                {
                  previousAgentId: activeAgent.id,
                  fallbackAgentId: fallbackConfig.agent,
                },
                "Retrying with fallback agent after failure",
              );
              const nextAgent = await getAgentById(fallbackConfig.agent);
              if (!nextAgent) {
                throw new Error(
                  `Fallback agent ${fallbackConfig.agent} not found`,
                );
              }
              if (
                !userOwnsRow(
                  {
                    id: activeAgent.userId,
                    organisationId: activeAgent.organisationId,
                  },
                  nextAgent,
                )
              ) {
                throw new Error(
                  `Fallback agent ${fallbackConfig.agent} does not belong to the same user or organization as the primary agent`,
                );
              }
              // Ensure nextAgent.options is parsed if needed
              let nextAgentOptions = nextAgent.options || {};
              // Switch active agent and model; subsequent fallback decisions will
              // be driven by the new agent's options.fallback.
              activeAgent = { ...nextAgent, options: nextAgentOptions };
              activeModelName = nextAgent.modelName;
              usedFallbackAgent = true;
              usedFallbackModel = false; // reset model fallback when switching agent
              continue fallbackLoop;
            } catch (agentError) {
              const aErr =
                agentError instanceof Error
                  ? agentError
                  : new Error(String(agentError));
              logger.error(
                {
                  error: aErr,
                  message: aErr.message,
                  stack: aErr.stack,
                  fallbackAgentId: fallbackConfig.agent,
                },
                "Failed to fetch or use fallback agent; continuing to other fallbacks",
              );
              // Fall through to model/number fallbacks
            }
          }

          // 2. Model-level fallback (restart with a different modelName)
          if (
            !busy &&
            !usedFallbackModel &&
            fallbackConfig.model &&
            activeModelName !== fallbackConfig.model
          ) {
            logger.info(
              {
                previousModelName: activeModelName,
                fallbackModelName: fallbackConfig.model,
              },
              "Retrying agent with fallback model after failure",
            );
            usedFallbackModel = true;
            activeModelName = fallbackConfig.model;
            // Loop again with updated modelName
            continue fallbackLoop;
          }

          // 3. Fixed-message fallback: play the operator's announcement.
          //
          // Terminal on success — the chain stops at the first step that works,
          // and the caller having heard the announcement *is* the outcome. The
          // original error is then rethrown so the outer handler performs its
          // usual setup-failure teardown: the call keeps its real failure reason
          // and stays diagnosable, with the announcement having been a courtesy
          // played on the way out rather than a different result.
          if (fallbackConfig.message) {
            const played = await playFixedFallbackMessage(ctx, activeAgent);
            if (played) {
              throw error;
            }
            logger.warn(
              {},
              "fixed fallback message unavailable; continuing down the fallback chain",
            );
          }

          // A busy call has no route left: the number fallback would reserve
          // concurrency it cannot get. Rethrow so the SIP leg is refused rather
          // than answered and dropped.
          if (busy) {
            throw error;
          }

          // 4. Number-level fallback (transfer to a phone number / endpoint)
          if (fallbackConfig.number) {
            try {
              logger.info(
                {
                  fallbackNumber: fallbackConfig.number,
                  error: error.message,
                },
                "Invoking fallback transfer after agent/model failure",
              );

              if (participant) {
                // Use runAgentWorker in transfer-only mode to set up proper handlers
                // This ensures we can detect when the transfer completes
                await runAgentWorker({
                  ctx,
                  room,
                  agent: activeAgent,
                  participant,
                  callerId,
                  calledId,
                  modelName: activeModelName, // Not used in transfer-only mode
                  metadata,
                  sendMessage,
                  call,
                  onHangup,
                  onTransfer,
                  modelRef,
                  sessionRef,
                  getBridgedParticipant: () => bridgedParticipant,
                  setBridgedParticipant: (p) => (bridgedParticipant = p),
                  checkForHangup,
                  getConsultInProgress: () => consultInProgress,
                  getActiveCall,
                  endTransferActivityIfNeeded: endTransferActivityFn,
                  getTransferState,
                  transferOnly: true,
                  transferArgs: {
                    number: fallbackConfig.number,
                    operation: "blind",
                  },
                });
              } else {
                logger.warn(
                  {
                    fallbackNumber: fallbackConfig.number,
                  },
                  "No participant available for fallback transfer",
                );
                throw new Error(
                  "No participant available for fallback transfer",
                );
              }
            } catch (transferError) {
              const tErr =
                transferError instanceof Error
                  ? transferError
                  : new Error(String(transferError));
              logger.error(
                {
                  error: tErr,
                  message: tErr.message,
                  stack: tErr.stack,
                  fallbackNumber: fallbackConfig.number,
                },
                "Fallback transfer failed",
              );
              // Re-throw to trigger outer error handling
              throw tErr;
            }

            // After attempting fallback transfer, break – call lifecycle will be
            // controlled by the transfer handler from this point on.
            break fallbackLoop;
          }

          // No applicable fallback path left; rethrow to outer handler
          throw error;
        }
      }
      // Store the function in outer scope for use in catch block
      endTransferActivityIfNeeded = endTransferActivityFn;
    } catch (e) {
      logger.error(
        `error: closing room ${(e as Error).message} ${(e as Error).stack}`,
      );
      const cleanup = async (): Promise<void> => {
        // Mark the call failed so it isn't left orphaned (no endedAt/reason):
        // this records the failure reason on the call and lets the diagnosis
        // loop find it. The InvocationLog is persisted by ctx.shutdown() below.
        try {
          if (recordedCall && !recordedCall._endCalled) {
            await recordedCall.end(
              `Agent setup failed: ${(e as Error).message}`,
            );
          }
        } catch (endErr) {
          logger.error({ endErr }, "error marking call failed during cleanup");
        }
        // End transfer activity if in progress
        // Note: endTransferActivityIfNeeded may not be available if error occurred before setupCallAndUtilities completed
        if (endTransferActivityIfNeeded) {
          try {
            await endTransferActivityIfNeeded("Error occurred");
          } catch (transferError) {
            logger.error(
              { transferError },
              "error ending transfer activity during error cleanup",
            );
          }
        }
        try {
          room && room.name && (await deleteRoomWithRetry(room.name));
        } catch (err) {
          logger.error({ err }, "error deleting room");
        }
        // Best-effort shutdown; invocation logs are only persisted when the agent
        // session has started and the shutdown callback has been registered.
        try {
          await ctx.shutdown((e as Error).message);
        } catch (err) {
          logger.error({ err }, "error shutting down");
        }
      };

      const cleanupTimeoutMs = parseInt(
        process.env.SETUP_FAILURE_CLEANUP_MS ?? "15000",
        10,
      );
      let cleanupTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        cleanup(),
        new Promise<void>((resolve) => {
          cleanupTimer = setTimeout(() => {
            logger.error(
              { cleanupTimeoutMs },
              "setup-failure cleanup timed out; abandoning it and ending the job",
            );
            resolve();
          }, cleanupTimeoutMs);
        }),
      ]);
      if (cleanupTimer) clearTimeout(cleanupTimer);

      // Returning from here is not enough — see above, the SDK will not
      // complete the job on its own. A job process is one-shot and the SDK's
      // own success path ends in process.exit(0) (job_proc_lazy_main.js), so
      // exiting reaches exactly the same end state while making an orphan
      // structurally impossible whichever step stalled. `done` first so the
      // pool's bookkeeping matches, then exit on the next tick so the IPC
      // write has a chance to flush.
      if (typeof process.send === "function") {
        try {
          process.send({ case: "done" });
        } catch {
          /* channel already closed */
        }
        logger.warn("setup failed; ending job process");
        setImmediate(() => process.exit(0));
      }
    }
  },
});

// ---- Helpers ----

/**
 * Collect every X- header from an inbound SIP INVITE into a
 * `{ "x-header-name": value }` map (keys lowercased) for
 * `metadata.aplisay.sipHeaders`.
 *
 * LiveKit's inbound trunk is created with `includeHeaders=SIP_X_HEADERS` (see
 * initialise.ts), which maps every `X-*` INVITE header to a `sip.h.x-*`
 * participant attribute — the header name lowercased — per the LiveKit SIP
 * participant reference. That dotted form is the authoritative source and is
 * lossless (strip the `sip.h.` prefix to recover the exact `x-header-name`).
 *
 * Some SDK/deploy paths have historically surfaced the same headers as
 * camelCased attribute keys instead (e.g. `sipHXAplisayTrunk` for
 * `sip.h.x-aplisay-trunk`; this is how the inbound routing reads its own
 * headers just below). We fold those in as a best-effort fallback ONLY when no
 * dotted `sip.h.x-*` keys are present, reconstructing the hyphenated name from
 * the camelCase word boundaries. That reconstruction is lossy for header names
 * whose original word breaks don't line up with the casing, so the dotted form
 * is always preferred when available.
 *
 * This deliberately includes the Aplisay/LiveKit routing headers
 * (`x-aplisay-trunk`, `x-lk-realip`, …) — they are genuine INVITE X- headers.
 */
function collectSipInviteHeaders(
  attributes: Record<string, string> | undefined | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!attributes) return out;
  const entries = Object.entries(attributes).filter(([, v]) => v != null);
  const hasDotted = entries.some(([k]) =>
    k.toLowerCase().startsWith("sip.h.x-"),
  );
  if (hasDotted) {
    for (const [k, v] of entries) {
      const lower = k.toLowerCase();
      if (lower.startsWith("sip.h.x-")) out[lower.slice("sip.h.".length)] = v;
    }
    return out;
  }
  // Best-effort camelCase fallback: `sipHX<Rest>` encodes `x-<rest>`, with the
  // `<Rest>` word boundaries carried by capitalisation (e.g. AplisayTrunk ->
  // aplisay-trunk).
  for (const [k, v] of entries) {
    const m = /^sipHX([A-Za-z0-9].*)$/.exec(k);
    if (!m) continue;
    const name =
      "x-" + m[1].replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    out[name] = v;
  }
  return out;
}

async function getCallInfo(ctx: JobContext, room: Room): Promise<CallScenario> {
  const jobMetadata: JobMetadata =
    (ctx.job.metadata && JSON.parse(ctx.job.metadata)) || {};
  let {
    callId,
    callerId,
    calledId,
    identity,
    instanceId,
    aplisayId,
    outbound,
    callMetadata,
  } = jobMetadata || {};
  logger.info(
    {
      callerId,
      calledId,
      instanceId,
      aplisayId,
      outbound,
      jobMetadata,
      identity,
      room,
    },
    "getting call info",
  );

  let phoneRegistration: string | null = null;
  let instance: Instance | null = null;
  let agent: Agent | null = null;
  let participant: ParticipantInfo | null = null;
  let bridgedParticipant: ParticipantInfo | null = null;
  let outboundCall = false;
  let outboundInfo: OutboundInfo | null = null;
  let registrationOriginated = false;
  let trunkInfo: TrunkInfo | null = null;
  let registrationRegistrar: string | null = null;
  let registrationTransport: string | null = null;
  // Registration trunk username (e.g. "8092"), used as the calling number toward
  // the gateway on transfer/bridge B-legs so PBXs that reject an unknown calling
  // number (e.g. Wildix -> 603 Decline) accept the call.
  let registrationUsername: string | null = null;
  let registrationEndpointId: string | null = null;
  let b2buaGatewayIp: string | null = null;
  let b2buaGatewayTransport: string | null = null;
  // All X- headers from the inbound SIP INVITE, harvested from the caller's
  // participant attributes (see collectSipInviteHeaders). Surfaced to the agent
  // as metadata.aplisay.sipHeaders. Stays {} for outbound / WebRTC.
  let sipHeaders: Record<string, string> = {};
  // Whether the inbound A-leg media is encrypted (SRTP). Drives the
  // media-encryption policy of the B-leg registration trunk used for transfers:
  // we only offer SRTP onward when the A-leg is itself encrypted, otherwise we
  // force plain RTP to avoid 603 Decline from plain-RTP-only endpoints (e.g.
  // some Wildix configurations). Defaults to true (offer SRTP) to preserve
  // prior behaviour when the B2BUA does not stamp the signal.
  let aLegEncrypted = true;
  let forceBridged: boolean | undefined = undefined;
  // Resolve a registration endpoint's "bridge instead of REFER" transfer default
  // from its options. The DOCUMENTED, snake_case key is `bridged_transfer` (see
  // docs/phone-endpoints-api.md / call-transfers.md); `forceBridged` is accepted as
  // a camelCase alias — that is the internal name the value maps to. Returns
  // undefined when neither key is present so the flag is only touched when the
  // endpoint actually specifies it. Truthy = boolean true or the string "true".
  const resolveRegistrationForceBridged = (
    options: Record<string, any> | null | undefined,
  ): boolean | undefined => {
    if (!options || typeof options !== "object") return undefined;
    const raw = options.bridged_transfer ?? options.forceBridged;
    if (raw === undefined) return undefined;
    return (
      raw === true ||
      (typeof raw === "string" && raw.trim().toLowerCase() === "true")
    );
  };
  /*

  Because we throw every media scenario into the same agent dispatch, working out which agent and capabilities from 
  the scenario is a bit complex:
  Outbound calls: our manual dispatch puts the number we want to call, CID and agent instanceID in the Job Metadata
  Inbound WebRTC calls: again, we put the instanceId in the Job Metadata as `identity` when we dispatch the call
  Inbound SIP calls: the livekit SIP call routing and dispatch puts SIP header information in the participant attributes
                      we use this to extract the called number, and then lookup which agent instance we should answer with.
  
  */
  try {
    // Various APIs may timeout here, so we need to set a timeout to avoid blocking the job.
    await withTimeout(
      async () => {
        if (outbound) {
          if (!calledId || !callerId || !instanceId) {
            logger.error({ ctx, calledId, callerId, aplisayId, instanceId }, "missing metadata for outbound call");
            throw new Error("Missing metadata for outbound call");
          }
          instance = await getInstanceById(instanceId);
          if (!instance) {
            logger.error(
              { ctx },
              `No instance found for outbound call (${calledId} => ${callerId}) ${instanceId} was incorrect`,
            );
            throw new Error("No instance found for outbound call");
          }
          // Do not perform side-effects here; signal to the caller to bridge
          outboundCall = true;
          const aplisayStr =
            aplisayId != null ? String(aplisayId).trim() : "";
          const callerIdStr = String(callerId);
          const uuidRe =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

          if (!aplisayStr && uuidRe.test(callerIdStr)) {
            const regEndpoint = await getPhoneEndpointById(callerIdStr);
            if (!regEndpoint || !("id" in regEndpoint)) {
              throw new Error(
                `Registration endpoint not found for outbound call: ${callerIdStr}`,
              );
            }
            const regInfo = regEndpoint as PhoneRegistrationInfo;
            if (!regInfo.outbound) {
              throw new Error(
                `Registration ${callerIdStr} is not enabled for outbound calling`,
              );
            }
            const optDisplay =
              regInfo.options &&
              typeof regInfo.options === "object" &&
              "displayNumber" in regInfo.options
                ? String(
                    (regInfo.options as { displayNumber?: string })
                      .displayNumber || "",
                  ).trim()
                : "";
            const cliRaw =
              optDisplay ||
              String(regInfo.username ?? "").trim();
            if (!cliRaw) {
              throw new Error(
                `Registration endpoint ${callerIdStr} has no username or options.displayNumber for outbound CLI`,
              );
            }
            registrationOriginated = true;
            registrationEndpointId = callerIdStr;
            // Honour the registration's bridged_transfer default for OUTBOUND-
            // originated calls too, so a transfer later in the call bridges rather
            // than REFERs when the endpoint (or its carrier) can't do REFER.
            const regForceBridged = resolveRegistrationForceBridged(
              regInfo.options,
            );
            if (regForceBridged !== undefined) {
              forceBridged = regForceBridged;
              logger.info(
                { forceBridged, registrationEndpointId: callerIdStr },
                "Extracted bridged_transfer (forceBridged) from outbound registration options",
              );
            }
            const gatewayHost = String(regInfo.b2buaId ?? "").trim();
            const gatewayTransport = "tcp";
            if (!gatewayHost) {
              throw new Error(
                `Registration endpoint ${callerIdStr} has no b2buaId (B2BUA gateway IP) for outbound calls`,
              );
            }
            b2buaGatewayIp = gatewayHost;
            b2buaGatewayTransport = gatewayTransport;
            callerId = cliRaw.replace(/^\+/, "");
            outboundInfo = {
              toNumber: calledId,
              fromNumber: callerId,
              instanceId: instanceId,
            };
          } else {
            outboundInfo = {
              toNumber: calledId,
              fromNumber: callerId,
              aplisayId: aplisayId,
              instanceId: instanceId,
            };
          }
        } else {
          logger.info({ room }, "room name getting participants");
          const participants = await getRoomService().listParticipants(
            room.name!,
          );
          participant = participants.find(
            (p) => p.identity !== "sip-outbound-call",
          ) as ParticipantInfo;
          bridgedParticipant = participants.find(
            (p) => p.identity === "sip-outbound-call",
          ) as ParticipantInfo | null;
          logger.debug(
            {
              participants: participants.length,
              participant,
              bridgedParticipant,
            },
            "have bridged participant?",
          );
          if (identity) {
            logger.debug({ identity }, "getting instance by identity");
            instance = await getInstanceById(identity);
            logger.debug({ instance }, "instance found?");
          } else if (room.name && participant?.attributes) {
            logger.debug(
              { participants, attributes: participant.attributes },
              "participants",
            );
            if (participant) {
              // Read via sipAttribute(): LiveKit delivers these dotted
              // (`sip.trunkPhoneNumber`, `sip.h.x-aplisay-trunk`, …), while
              // some paths have used camelCase aliases. Reading only the
              // camelCase form left every value undefined against a real
              // dotted-key participant, so inbound calls failed to resolve to
              // an instance. See lib/sip-attributes.ts.
              const attrs = participant.attributes || {};
              const calledIdAttr = sipAttribute(attrs, "calledNumber");
              const callerIdAttr = sipAttribute(attrs, "callerNumber");
              const aplisayIdAttr = sipAttribute(attrs, "aplisayTrunk");
              const phoneRegistrationAttr = sipAttribute(
                attrs,
                "phoneRegistration",
              );
              const sipHostnameAttr = sipAttribute(attrs, "sipHostname");
              const b2buaGatewayIpAttr = sipAttribute(attrs, "lkRealIp");
              const b2buaGatewayTransportAttr = sipAttribute(
                attrs,
                "lkTransport",
              );
              const aLegMediaEncryptionAttr = sipAttribute(
                attrs,
                "lkMediaEncryption",
              );

              calledId = calledIdAttr;
              // A registration trunk's INVITE reaches LiveKit on the trunk's
              // fixed number; the dialled number rides in X-Aplisay-Called.
              const aplisayCalledAttr = sipAttribute(attrs, "aplisayCalled");
              if (aplisayCalledAttr) calledId = aplisayCalledAttr;
              callerId = callerIdAttr;
              aplisayId = aplisayIdAttr;
              phoneRegistration = phoneRegistrationAttr ?? null;

              // Surface all inbound INVITE X- headers as metadata.aplisay.sipHeaders.
              // This is the inbound-SIP branch, so every such call qualifies (the
              // upstream SBC — sipbridge/voiceblender/etc. — stamps the X- headers,
              // which LiveKit maps to sip.h.x-* participant attributes).
              sipHeaders = collectSipInviteHeaders(participant.attributes);

              // Determine A-leg media encryption from the B2BUA-stamped header
              // (X-Lk-Media-Encryption -> sipHXLkMediaEncryption). When the
              // header is absent we keep the default (true) to preserve prior
              // behaviour. The value is treated as plain RTP only when it
              // explicitly indicates no/disabled encryption.
              if (aLegMediaEncryptionAttr != null && aLegMediaEncryptionAttr !== '') {
                const enc = String(aLegMediaEncryptionAttr).trim().toLowerCase();
                aLegEncrypted = !['disable', 'disabled', 'none', 'off', 'no', 'false', '0', 'rtp', 'plain', 'unencrypted'].includes(enc);
                logger.info(
                  { aLegMediaEncryption: aLegMediaEncryptionAttr, aLegEncrypted },
                  "Extracted A-leg media encryption from participant attributes",
                );
              }

              // Store registration endpoint ID for transfer operations
              if (phoneRegistration) {
                registrationEndpointId = phoneRegistration;
              }

              // Store B2BUA gateway information for routing outbound calls
              if (b2buaGatewayIpAttr) {
                b2buaGatewayIp = b2buaGatewayIpAttr;
                b2buaGatewayTransport = b2buaGatewayTransportAttr || null;
                logger.info(
                  { b2buaGatewayIp, b2buaGatewayTransport },
                  "Extracted B2BUA gateway information from participant attributes",
                );
              }

              // If we have sipHostname but no registrar from endpoint lookup, use sipHostname
              // (sipHostname is the registrar hostname from the inbound call)
              if (
                phoneRegistration &&
                sipHostnameAttr &&
                !registrationRegistrar
              ) {
                registrationRegistrar = sipHostnameAttr;
                logger.info(
                  { sipHostname: sipHostnameAttr },
                  "Using sipHostname as registrar from participant attributes",
                );
              }
            }

            calledId = calledId?.replace("+", "");
            callerId = callerId?.replace("+", "");

            // If we have a phoneRegistration ID, lookup the phone endpoint by ID
            // Otherwise, use the calledId (phone number) to lookup by number
            if (phoneRegistration) {
              registrationOriginated = true;
              logger.info(
                { callerId, phoneRegistration, aplisayId },
                "new Livekit inbound telephone call, looking up phone endpoint by registration ID",
              );
              const phoneEndpoint =
                await getPhoneEndpointById(phoneRegistration);
              if (phoneEndpoint && "id" in phoneEndpoint) {
                const regInfo = phoneEndpoint as PhoneRegistrationInfo;
                logger.info(
                  { phoneEndpoint: regInfo },
                  "found phone registration endpoint",
                );
                // Store registrar and transport for transfer operations
                registrationRegistrar = regInfo.registrar || null;
                registrationTransport = regInfo.options?.transport || null;
                // Trunk username (= the A-leg's To-user / SIP extension), used as
                // the calling number presented toward the gateway on transfers.
                registrationUsername = regInfo.username || null;
                // Registration transfer default: documented as
                // options.bridged_transfer (snake_case); surfaces internally as
                // forceBridged. Accepts the forceBridged alias too. See
                // docs/phone-endpoints-api.md / call-transfers.md.
                const regForceBridged = resolveRegistrationForceBridged(
                  regInfo.options,
                );
                if (regForceBridged !== undefined) {
                  forceBridged = regForceBridged;
                  logger.info(
                    { forceBridged, phoneRegistration },
                    "Extracted bridged_transfer (forceBridged) from phone registration options",
                  );
                }
                // PhoneRegistration now has instanceId, so we can lookup the instance
                if (regInfo.instanceId) {
                  instance = await getInstanceById(regInfo.instanceId);
                  logger.info(
                    { instanceId: regInfo.instanceId, instance },
                    "found instance from registration instanceId",
                  );
                }
              }
            }
            // A registration with no agent attached is a registration TRUNK:
            // the call resolves by (dialled number, trunk) like any other
            // trunk call. Same ladder as pipecat's _lookup_instance_for_inbound.
            if (!instance && calledId) {
              logger.info(
                { callerId, calledId, aplisayId },
                "new Livekit inbound telephone call, looking up phone endpoint by number",
              );
              // Pass trunkId (aplisayId) for validation - will throw error if mismatch
              const phoneEndpoint = await getPhoneEndpointByNumber(
                calledId,
                aplisayId,
              );
              if (phoneEndpoint && "number" in phoneEndpoint) {
                const numInfo = phoneEndpoint as PhoneNumberInfo;
                logger.info(
                  { phoneEndpoint: numInfo },
                  "found phone number endpoint",
                );
                // Store trunk info if available
                if (numInfo.trunk) {
                  trunkInfo = numInfo.trunk;
                  logger.info(
                    { trunkInfo },
                    "trunk info retrieved from phone endpoint",
                  );
                }
                // The number row names its instance. There is deliberately no
                // lookup by bare number behind this: an inbound call is
                // resolved by (number, trunk) or not at all, so a number that
                // failed the trunk check above, or has no agent, is "no
                // instance" rather than "try again without the trunk".
                if (numInfo.instanceId) {
                  instance = await getInstanceById(numInfo.instanceId);
                }
                aplisayId = numInfo.aplisayId || aplisayId;
              }
            }
          }
        }
      },
      5000,
      new Error("Call setup timeout (getCallInfo)"),
      () => logger.error({ ctx }, "info timeout"),
    );
  } catch (e) {
    logger.error({ e }, "error getting call info");
    throw e instanceof Error ? e : new Error(String(e));
  }
  if (!instance) {
    logger.error(
      { participant },
      `no instance found for inbound call (${calledId} => ${callerId} or ${identity})`,
    );
    throw new Error("No instance found");
  }

  agent = agent || (instance as Instance)?.Agent || null;
  calledId = calledId || "WebRTC";
  callerId = callerId || "WebRTC";

  return {
    instance: instance!,
    agent,
    participant,
    existingBridge: bridgedParticipant,
    callerId: callerId!,
    calledId: calledId!,
    aplisayId: aplisayId!,
    callId: callId!,
    callMetadata: callMetadata || {},
    outboundCall,
    outboundInfo,
    registrationOriginated,
    trunkInfo,
    registrationRegistrar,
    registrationTransport,
    registrationUsername,
    registrationEndpointId,
    b2buaGatewayIp,
    b2buaGatewayTransport,
    aLegEncrypted,
    forceBridged,
    sipHeaders,
  };
}

/*
 * This is a hack to give a decent customer experience in the case where a previous agent worker has crashed,
 * but there were bridged conversations in progress in it's rooms.
 *
 * If we don't do this then we would fall through and create a new agent in the room which then starts talking to the customer
 * participants who are already in the room.
 *
 * Instead we stall all processing here until the participant disconnects, or 10 minutes passes.
 *
 * It is not a perfect solution, but it is a better experience for the customer.
 *
 */
/**
 * Play an agent's fixed fallback announcement (`options.fallback.message`).
 *
 * Never throws: this runs when setup has already failed, so a problem here must
 * cost the caller the announcement and nothing more, leaving the fallback chain
 * free to try `fallback.number`.
 *
 * Connects to the room if we are not already in it. The main flow reserves
 * concurrency in `Call.start()` *before* `ctx.connect()` precisely so a refused
 * call is never answered — which means the busy path arrives here having never
 * joined, and audio cannot be published from outside the room. Connecting
 * answers the SIP leg, and that is the intended trade: an operator who
 * configured an announcement has asked for the caller to hear it instead of
 * getting a busy tone.
 *
 * Publishes from `ctx.room` rather than the worker's `room`, which is the job
 * assignment's room info and has no local participant to publish from.
 */
async function playFixedFallbackMessage(
  ctx: JobContext,
  agent: Agent,
): Promise<boolean> {
  try {
    if (!ctx.room?.isConnected) {
      await ctx.connect();
    }
    return await runFallbackMessage(ctx.room, agent);
  } catch (e) {
    logger.error({ e }, "fixed fallback message failed");
    return false;
  }
}

async function waitForExistingBridgedParticipant(
  ctx: JobContext,
  room: Room,
  bridgedParticipant: ParticipantInfo,
): Promise<string> {
  if (!bridgedParticipant) {
    return "no bridged participant found";
  }
  // We have already bridged this call, so we need to get the bridged participant
  const roomInfo = await getRoomService().listRooms([room.name!]);
  const metadata = roomInfo[0]?.metadata as any;
  const bridgedCallId = JSON.parse(metadata)?.bridgedCallId || null;
  logger.info(
    { metadata, bridgedCallId, bridgedParticipant },
    "got existing bridged call room metadata",
  );
  ctx.connect();
  const disconnected = new Promise<string>((resolve, reject) => {
    ctx.room.on(
      RoomEvent.ParticipantDisconnected,
      async (p: RemoteParticipant) => {
        logger.info({ p }, "participant of already bridged call disconnected");
        resolve("participant of already bridged call disconnected");
      },
    );
    setTimeout(
      () => {
        resolve(
          "Participant of already bridged call did not disconnect after 10 minutes",
        );
      },
      10 * 60 * 1000,
    );
  });
  let reason = await disconnected;
  bridgedCallId &&
    (await endCallById(
      bridgedCallId,
      `Bridged call already existed: ${reason}`,
    ));
  return reason;
}

async function setupCallAndUtilities({
  ctx,
  room,
  instance,
  agent,
  callerId,
  calledId,
  aplisayId,
  callId,
  callMetadata,
  userId,
  organisationId,
  modelName,
  options,
  modelRef,
  sessionRef,
  setBridgedParticipant,
  setConsultInProgress,
  getConsultInProgress,
  outbound,
  registrationOriginated,
  trunkInfo,
  registrationRegistrar,
  registrationTransport,
  registrationUsername,
  registrationEndpointId,
  b2buaGatewayIp,
  b2buaGatewayTransport,
  aLegEncrypted = true,
  forceBridged,
  sipHeaders = {},
  requestHangup,
  participant: originalParticipant,
}: SetupCallParams & { participant?: ParticipantInfo | null }) {
  const { fallback: { number: fallbackNumbers } = {} } = options || {};
  logger.info(
    { agent, instance, aplisayId, calledId, callerId, ctx, room },
    "new room instance",
  );

  let wantHangup = false;
  // Set by the voice runtime once its stack is up (see registerHangupExecutor);
  // null before that and after teardown. onHangup calls it to close the call
  // itself instead of waiting for a state-change edge that may never come.
  let hangupExecutor: HangupExecutor | null = null;
  const registerHangupExecutor = (execute: HangupExecutor | null) => {
    hangupExecutor = execute;
  };
  let currentBridged: SipParticipant | null = null;
  let bridgedCallRecord: Call | null = null;
  const setBridgedCallRecord = (call: Call | null) => {
    bridgedCallRecord = call;
  };

  // Consultation room state for warm transfers
  let consultRoomName: string | null = null;
  let transferSession: voice.AgentSession | null = null;
  let consultRoom: Room | null = null;

  const getCurrentBridged = () => currentBridged;
  const setCurrentBridged = (p: SipParticipant | null) => {
    currentBridged = p;
  };

  const getConsultRoomName = () => consultRoomName;
  const setConsultRoomName = (name: string | null) => {
    consultRoomName = name;
  };

  const getTransferSession = () => transferSession;
  const setTransferSession = (session: voice.AgentSession | null) => {
    transferSession = session;
  };

  const getConsultRoom = () => consultRoom;
  const setConsultRoom = (room: Room | null) => {
    consultRoom = room;
  };
  let consultCall: Call | null = null;
  const getConsultCall = () => consultCall;
  const setConsultCall = (call: Call | null) => {
    consultCall = call;
  };

  // Transfer state tracking
  let transferState: {
    state: "none" | "dialling" | "talking" | "rejected" | "failed";
    description: string;
  } = {
    state: "none",
    description: "No transfer in progress",
  };
  // Confidence tone during transfers (options.transferTone): a comfort beep
  // toward the caller while a blind transfer is being placed, and to fill
  // the silent gaps during a consultation. Armed in onTransfer; play/stop is
  // derived from the transfer state via the setTransferState funnel below.
  // Null (zero behaviour change) when the option is unset.
  const toneConfig = toneConfigFromOptions(options);
  const tonePlayer = toneConfig
    ? new ConfidenceTonePlayer(
        toneConfig,
        () => ctx.room as Room | null | undefined,
        () => sessionRef(null),
      )
    : null;

  // Human→agent takeover capability (options.bridgedTransferToAgent): the
  // voice runtime registers its live handover machinery here once its stack
  // is up (and clears it on teardown); the transfer handler reads it when a
  // bridged transfer completes to arm the post-bridge DTMF watch.
  let bridgedTakeoverRuntime: BridgedTakeoverRuntime | null = null;
  const registerBridgedTakeover = (rt: BridgedTakeoverRuntime | null) => {
    bridgedTakeoverRuntime = rt;
  };

  const getTransferState = () => transferState;
  const setTransferState = (
    state: "none" | "dialling" | "talking" | "rejected" | "failed",
    description: string,
  ) => {
    transferState = { state, description };
    tonePlayer?.notifyTransferState(state);
    logger.debug({ state, description }, "Transfer state updated");
  };

  const call = await createCall({
    id: callId,
    userId,
    organisationId,
    instanceId: instance.id,
    agentId: agent.id,
    platform: "livekit",
    platformCallId: room?.name,
    calledId,
    callerId,
    modelName,
    // Destination billing (D3): only an org-originated OUTBOUND leg carried on our
    // public trunk is chargeable — inbound legs and registration egress are not.
    outboundTrunkId: outbound ? chargeableOutboundTrunkId(registrationOriginated) : undefined,
    options,
    metadata: {
      ...instance.metadata,
      ...(callMetadata || {}),
      aplisay: {
        callerId,
        calledId,
        fallbackNumbers,
        model: agent.modelName,
        // Inbound SIP INVITE X- headers (empty for outbound / WebRTC). Referenced
        // in prompts/tools via metadata paths like `aplisay.sipHeaders.x-my-header`.
        ...(Object.keys(sipHeaders).length ? { sipHeaders } : {}),
      },
    },
  });

  const { metadata } = call;
  metadata.aplisay = metadata.aplisay || {};
  metadata.aplisay.callId = call.id;

  // The call record the live agent is currently attributed to. A full
  // agent-stack handover (transfer_agent with a model change) replaces this
  // with a child call (parentId = original) so transcripts, teardown and
  // usage follow the new agent + model.
  let activeAgentCall: Call = call;
  const setActiveAgentCall = (next: Call) => {
    (next as any).batchedTransactionLogs =
      (next as any).batchedTransactionLogs || [];
    activeAgentCall = next;
  };

  // Array to batch transaction logs when streamLog is false
  const batchedTransactionLogs: Array<{
    userId: string;
    organisationId: string;
    callId: string;
    type: string;
    data?: string;
    isFinal?: boolean;
    createdAt?: Date;
  }> = [];

  const sendMessage = async (message: MessageData, createdAt?: Date) => {
    try {
      const entries = Object.entries(message);
      if (entries.length > 0) {
        const [type, data] = entries[0] as [string, unknown];
        ctx.room.localParticipant?.publishData(
          new TextEncoder().encode(JSON.stringify(message)),
          { reliable: true },
        );

        logger.debug({ message, type: typeof message }, "sending message");

        if (type === "status") {
          return;
        }

        // Use provided createdAt timestamp if available, otherwise use current time
        // This preserves the original event timestamp from ConversationItemAdded events
        const logCreatedAt = createdAt || new Date();

        const transactionLogData = {
          userId,
          organisationId,
          callId: activeAgentCall.id,
          type,
          data: JSON.stringify(data),
          isFinal: true,
          createdAt: logCreatedAt,
        };

        // If streamLog is enabled, push immediately; otherwise batch for end
        // call — onto the ACTIVE call so each record's logs end with it.
        if (instance.streamLog === true) {
          await createTransactionLog(transactionLogData);
        } else {
          (
            ((activeAgentCall as any).batchedTransactionLogs ??
              batchedTransactionLogs) as typeof batchedTransactionLogs
          ).push(transactionLogData);
        }
      }
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      logger.error(
        { error, message: error.message, stack: error.stack },
        "error sending message",
      );
    }
  };

  const onTransfer = async ({
    args,
    participant: transferParticipant,
  }: {
    args: TransferArgs;
    participant: ParticipantInfo;
  }) => {
    try {
      // Arm the confidence tone for this transfer (skip if a transfer is
      // already in flight — handleTransfer will reject it without touching
      // the transfer state, and the in-flight one still owns the tone).
      if (tonePlayer && !getConsultInProgress()) {
        tonePlayer.arm(
          args.operation === "consultative" ? "consult" : "blind",
        );
      }
      const transferContext: TransferContext = {
        ctx,
        room,
        participant: transferParticipant,
        args,
        agent,
        instance,
        call,
        callerId,
        calledId,
        aplisayId,
        registrationOriginated: registrationOriginated || false,
        trunkInfo,
        registrationRegistrar,
        registrationTransport,
        registrationUsername,
        registrationEndpointId,
        b2buaGatewayIp: b2buaGatewayIp ?? null,
        b2buaGatewayTransport: b2buaGatewayTransport ?? null,
        aLegEncrypted,
        forceBridged,
        options,
        sessionRef,
        setBridgedParticipant,
        setConsultInProgress,
        getConsultInProgress,
        getCurrentBridged,
        setCurrentBridged,
        setConsultRoomName,
        getConsultRoomName,
        setTransferSession,
        getTransferSession,
        setConsultCall,
        getConsultCall,
        setConsultRoom,
        getConsultRoom,
        setTransferState,
        getTransferState,
        setBridgedCallRecord,
        getBridgedTakeover: () => bridgedTakeoverRuntime,
      };

      return await handleTransfer(transferContext);
    } catch (e: any) {
      // A throw here means the transfer died (often before any state change,
      // e.g. argument validation) — don't leave the tone armed for it.
      tonePlayer?.disarm();
      let error = e as Error;
      if (!(e instanceof Error)) {
        logger.error(
          { e: String(e) },
          `Expected error, got ${e} (${typeof e})`,
        );
        error = new Error(e);
      }
      logger.error(
        { error, message: error.message, stack: error.stack },
        `error transferring participant`,
      );
      return { error: error.message };
    }
  };

  const checkForHangup = () => {
    return wantHangup;
  };

  async function onHangup(): Promise<HangupResult> {
    // Idempotent: a model that calls hangup twice must not re-arm teardown,
    // and must be told plainly that the first call was accepted. Returning the
    // same cheerful "call is ending" for a repeat invites another repeat.
    if (wantHangup) {
      return {
        status: "OK",
        detail:
          "hangup is already in progress and the call is ending — do not call hangup again",
      };
    }
    wantHangup = true;

    // Drive teardown directly rather than relying solely on the runtime's
    // AgentStateChanged → "listening" edge. That edge only fires on a state
    // TRANSITION, so a hangup issued while the session is already listening —
    // e.g. a tool-call-only turn with no closing utterance — never fires it,
    // the latch is never read, and the call stays up and billed until the far
    // end drops. Not awaited: teardown must not block this tool's result, and
    // the executor applies its own grace period so the result still flushes.
    hangupExecutor?.();

    return {
      status: "OK",
      detail: "the call is ending now — say nothing further",
    };
  }

  // Helper function to destroy any in-progress transfer when original caller disconnects
  const endTransferActivityIfNeeded = async (reason: string) => {
    await destroyInProgressTransfer(
      getConsultInProgress,
      getConsultRoomName,
      getTransferSession,
      getConsultRoom,
      getConsultCall,
      setConsultInProgress,
      agent,
      reason,
      setTransferState,
    );
  };
  // Attach batched transaction logs to the call object for access during end()
  (call as any).batchedTransactionLogs = batchedTransactionLogs;

  return {
    call,
    metadata,
    sendMessage,
    onHangup,
    onTransfer,
    checkForHangup,
    modelRef,
    sessionRef,
    // Registration point for the runtime's bridged human→agent takeover
    // capability (options.bridgedTransferToAgent).
    registerBridgedTakeover,
    // Registration point for the runtime's direct teardown path, used by
    // onHangup so an agent-initiated hangup cannot strand the call.
    registerHangupExecutor,
    // expose helper to check the currently active call for logging
    getActiveCall: () => bridgedCallRecord || activeAgentCall,
    // The agent's own call WITHOUT the bridge override — usage attribution must
    // target this so agent-session component meters never land on the no-agent
    // bridged tail leg (whose only billable component is its audio-path minutes).
    getAgentCall: () => activeAgentCall,
    setActiveAgentCall,
    endTransferActivityIfNeeded,
    getTransferState,
    // Comfort tone over a full-stack agent handover gap (no-ops when
    // options.transferTone is unset, i.e. tonePlayer is null).
    startHandoverTone: () => tonePlayer?.startHandover(),
    stopHandoverTone: () => tonePlayer?.stopHandover(),
  };
}
