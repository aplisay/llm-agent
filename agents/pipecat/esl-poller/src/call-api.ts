// HTTP call-control API for the Pipecat worker.
//
// The Pipecat worker is in Python; it does not speak ESL directly. This module
// adds an HTTP surface on top of the existing esl-poller process so the worker
// can:
//
//   - originate outbound calls
//   - issue REFER (uuid_deflect) or blind-bridge (originate+bridge) transfers
//   - hang up calls (uuid_kill)
//   - subscribe to channel events (CHANNEL_HANGUP, CHANNEL_BRIDGE) via a webhook
//
// The same esl-poller binary is reused; this module is bolted on alongside the
// existing gateway-state poller (which itself is now opt-in via
// GATEWAY_POLL_ENABLED so the binary stays useful in either deployment).
import express from "express";
import type { Express, Request, Response } from "express";
import type pino from "pino";
import axios from "axios";
import { randomUUID } from "node:crypto";
import { FreeSwitchClient } from "esl-lite";

const CALL_API_PORT = Number(process.env.CALL_API_PORT || 4001);
const CALL_API_TOKEN = process.env.CALL_API_TOKEN || "";
const WORKER_EVENT_WEBHOOK = process.env.WORKER_EVENT_WEBHOOK || "";
const WORKER_EVENT_TOKEN = process.env.WORKER_EVENT_TOKEN || CALL_API_TOKEN;
const ESL_TIMEOUT = Number(process.env.ESL_TIMEOUT || 5000);

export interface OriginateBody {
  /** Full destination (E.164 PSTN number, SIP URI, or gateway/<number> form). */
  destination: string;
  callerId: string;
  callId: string;
  aplisayId?: string | null;
  /** Optional pre-assigned channel UUID; one is generated if absent. */
  channelUuid?: string;
  /** Optional gateway through which to route the outbound call. */
  gateway?: string;
  /** Registration-origin routing (mirrors the sipbridge/voiceblender contract).
   *  When registrationEndpointId + b2buaGatewayIp are present, the call is
   *  routed to that registration's b2bua instead of the default SBC gateway. */
  registrationEndpointId?: string | null;
  b2buaGatewayIp?: string | null;
  b2buaGatewayTransport?: string | null;
}

export interface TransferBody {
  destination: string;
  /** "refer" → uuid_deflect (REFER); "bridge" → blind-bridge. */
  operation: "refer" | "bridge";
  callerIdOverride?: string;
  aplisayCallId?: string;
}

/** Result returned to the worker on origination — channel UUID + status. */
export interface OriginateResult {
  channelUuid: string;
  ok: boolean;
  message: string;
}

export interface CallApiOptions {
  client: FreeSwitchClient;
  logger: pino.Logger;
}

function requireToken(req: Request, res: Response): boolean {
  if (!CALL_API_TOKEN) return true;
  const auth = req.header("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    res.status(401).json({ error: "missing bearer token" });
    return false;
  }
  const token = auth.slice(7).trim();
  if (token !== CALL_API_TOKEN) {
    res.status(401).json({ error: "invalid bearer token" });
    return false;
  }
  return true;
}

/**
 * Push a structured channel event to the Pipecat worker.
 *
 * The worker subscribes via env var rather than over a maintained connection
 * — webhook style is easier to deploy through container networking and matches
 * the existing config-server posting pattern.
 */
async function postEventToWorker(
  payload: Record<string, unknown>,
  logger: pino.Logger,
): Promise<void> {
  if (!WORKER_EVENT_WEBHOOK) return;
  try {
    await axios.post(WORKER_EVENT_WEBHOOK, payload, {
      headers: WORKER_EVENT_TOKEN
        ? { Authorization: `Bearer ${WORKER_EVENT_TOKEN}` }
        : undefined,
      timeout: 5000,
    });
  } catch (err) {
    logger.warn({ err, payload }, "failed to post event to worker");
  }
}

/**
 * Wire FreeSWITCH channel events into a webhook stream. The worker decides
 * what to do with them; this module is just the relay.
 */
function wireChannelEventForwarding({ client, logger }: CallApiOptions): void {
  const forward = async (eventName: string, ev: any) => {
    const headers = ev?.body?.headers || ev?.body || {};
    const uniqueId = headers["Unique-ID"] || headers["unique-id"];
    if (!uniqueId) return;
    await postEventToWorker(
      {
        event: eventName,
        channelUuid: uniqueId,
        callerId: headers["Caller-Caller-ID-Number"],
        calledId: headers["Caller-Destination-Number"],
        hangupCause: headers["Hangup-Cause"],
        bridgedTo: headers["Other-Leg-Unique-ID"],
        // Aplisay-stamped headers travel via the channel variables we set in
        // the dialplan. mod_audio_stream attaches them in its own start event,
        // not on CHANNEL_HANGUP / CHANNEL_BRIDGE.
        aplisayTrunk: headers["variable_aplisay_trunk"],
        aplisayCallId: headers["variable_aplisay_call_id"],
      },
      logger,
    );
  };

  client.custom.on("CHANNEL_HANGUP", (ev: any) => void forward("CHANNEL_HANGUP", ev));
  client.custom.on("CHANNEL_BRIDGE", (ev: any) => void forward("CHANNEL_BRIDGE", ev));
  client.custom.on("CHANNEL_ANSWER", (ev: any) => void forward("CHANNEL_ANSWER", ev));
}

/** Strip a leading sip:/sips: scheme from a host or URI (mirrors sipbridge's
 *  `_strip_sip_scheme`). */
function stripSipScheme(s: string): string {
  return s.replace(/^sips?:/i, "");
}

/** Resolve a registration's b2bua SIP authority the same way sipbridge does
 *  (`_outbound_target_uri`): use the IP as-is if it already carries a port,
 *  else default to the b2bua's SIP port 5070. */
function b2buaAuthority(ip: string): string {
  const host = stripSipScheme(ip).trim();
  return host.includes(":") ? host : `${host}:5070`;
}

/**
 * Build the originate variables string (FreeSWITCH `{k=v,k=v}` syntax).
 */
function buildOriginateVars(body: OriginateBody, channelUuid: string): string {
  const parts = [
    `origination_uuid=${channelUuid}`,
    `origination_caller_id_number=${body.callerId}`,
    `origination_caller_id_name=${body.callerId}`,
    `aplisay_call_id=${body.callId}`,
    `dialplan_target=outbound`,
    `sip_h_X-Aplisay-Origin-Caller-Id=${body.callerId}`,
    `sip_h_X-Aplisay-Call-Id=${body.callId}`,
  ];
  if (body.aplisayId) {
    parts.push(`aplisay_trunk=${body.aplisayId}`);
    parts.push(`sip_h_X-Aplisay-Trunk=${body.aplisayId}`);
  }
  // Registration-origin routing: when the worker supplies a b2bua gateway IP,
  // stamp the authority + transport so the dialplan bridges straight to that
  // b2bua instead of the default SBC gateway. The X-Lk-* headers mirror the
  // section-6 wire contract carried by sipbridge.
  if (body.b2buaGatewayIp) {
    const transport = body.b2buaGatewayTransport || "tcp";
    parts.push(`aplisay_b2bua_authority=${b2buaAuthority(body.b2buaGatewayIp)}`);
    parts.push(`aplisay_b2bua_transport=${transport}`);
    parts.push(`sip_h_X-Lk-RealIp=${stripSipScheme(body.b2buaGatewayIp)}`);
    parts.push(`sip_h_X-Lk-Transport=${transport}`);
    if (body.registrationEndpointId) {
      parts.push(`sip_h_X-Aplisay-PhoneRegistration=${body.registrationEndpointId}`);
    }
  }
  return parts.join(",");
}

export function buildCallApi({ client, logger }: CallApiOptions): Express {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/calls/originate", async (req, res) => {
    if (!requireToken(req, res)) return;
    const body = req.body as OriginateBody;
    if (!body?.destination || !body?.callerId || !body?.callId) {
      res.status(400).json({ error: "destination, callerId and callId are required" });
      return;
    }
    const channelUuid = body.channelUuid || randomUUID();
    const vars = buildOriginateVars(body, channelUuid);
    const target = body.gateway
      ? `sofia/gateway/${body.gateway}/${body.destination}`
      : `loopback/${body.destination}/outbound`;
    const cmd = `originate {${vars}}${target} &park`;
    logger.info({ cmd, channelUuid }, "originate call");
    try {
      const result = await client.bgapi(cmd, ESL_TIMEOUT);
      const responseBody = "body" in result ? (result.body as any)?.response ?? "" : "";
      const ok = typeof responseBody === "string" && responseBody.startsWith("+OK");
      const out: OriginateResult = {
        channelUuid,
        ok,
        message: typeof responseBody === "string" ? responseBody.trim() : "",
      };
      res.json(out);
    } catch (err: any) {
      logger.error({ err, cmd }, "originate failed");
      res.status(500).json({ error: err?.message || "originate failed" });
    }
  });

  app.post("/calls/:uuid/transfer", async (req, res) => {
    if (!requireToken(req, res)) return;
    const { uuid } = req.params;
    const body = req.body as TransferBody;
    if (!body?.destination || !body?.operation) {
      res.status(400).json({ error: "destination and operation required" });
      return;
    }
    try {
      if (body.callerIdOverride) {
        await client.bgapi(
          `uuid_setvar ${uuid} sip_h_X-Aplisay-Origin-Caller-Id ${body.callerIdOverride}`,
          ESL_TIMEOUT,
        );
      }
      if (body.aplisayCallId) {
        await client.bgapi(
          `uuid_setvar ${uuid} sip_h_X-Aplisay-Call-Id ${body.aplisayCallId}`,
          ESL_TIMEOUT,
        );
      }

      if (body.operation === "refer") {
        await client.bgapi(`uuid_deflect ${uuid} ${body.destination}`, ESL_TIMEOUT);
      } else {
        const newUuid = randomUUID();
        const vars = [
          `origination_uuid=${newUuid}`,
          `origination_caller_id_number=${body.callerIdOverride ?? ""}`,
          `sip_h_X-Aplisay-Origin-Caller-Id=${body.callerIdOverride ?? ""}`,
        ].join(",");
        const cmd = `originate {${vars}}sofia/external/${body.destination} &bridge(${uuid})`;
        logger.info({ cmd, fromUuid: uuid, newUuid }, "blind-bridge transfer");
        await client.bgapi(cmd, ESL_TIMEOUT);
        res.json({ ok: true, newChannelUuid: newUuid });
        return;
      }
      res.json({ ok: true });
    } catch (err: any) {
      logger.error({ err, uuid }, "transfer failed");
      res.status(500).json({ error: err?.message || "transfer failed" });
    }
  });

  /**
   * Install a media bridge between two existing channels via FreeSWITCH's
   * ``uuid_bridge`` command. Used by the LiveKit-parity consultative-
   * transfer flow: after the TransferAgent's ``accept_transfer`` tool
   * fires on the consult bot, the worker calls this with the original
   * call's channel uuid as ``:uuid`` and the consult call's channel
   * uuid as ``peerUuid``. FreeSWITCH joins them in a 2-party media
   * bridge; the bot WSes get torn down as the channels leave the
   * Pipecat-attached state.
   *
   * Mirrors the sipbridge ``POST /v1/calls/{id}/transfer { mode:
   * "bridged", target: <other> }`` primitive and voiceblender's
   * room-based bridge. See ``docs/call-transfers.md``.
   */
  app.post("/calls/:uuid/bridge", async (req, res) => {
    if (!requireToken(req, res)) return;
    const { uuid } = req.params;
    const body = req.body as { peerUuid?: string };
    if (!body?.peerUuid) {
      res.status(400).json({ error: "peerUuid required" });
      return;
    }
    try {
      const cmd = `uuid_bridge ${uuid} ${body.peerUuid}`;
      logger.info({ cmd, uuid, peerUuid: body.peerUuid }, "bridging channels");
      await client.bgapi(cmd, ESL_TIMEOUT);
      res.json({ ok: true });
    } catch (err: any) {
      logger.error({ err, uuid, peerUuid: body.peerUuid }, "bridge failed");
      res.status(500).json({ error: err?.message || "bridge failed" });
    }
  });

  app.post("/calls/:uuid/hangup", async (req, res) => {
    if (!requireToken(req, res)) return;
    const { uuid } = req.params;
    const cause = (req.body?.cause as string) || "NORMAL_CLEARING";
    try {
      await client.bgapi(`uuid_kill ${uuid} ${cause}`, ESL_TIMEOUT);
      res.json({ ok: true });
    } catch (err: any) {
      logger.error({ err, uuid }, "hangup failed");
      res.status(500).json({ error: err?.message || "hangup failed" });
    }
  });

  return app;
}

export function startCallApi(options: CallApiOptions): void {
  const app = buildCallApi(options);
  wireChannelEventForwarding(options);
  app.listen(CALL_API_PORT, () => {
    options.logger.info(
      { port: CALL_API_PORT, webhookConfigured: !!WORKER_EVENT_WEBHOOK },
      "call-control API listening",
    );
  });
}
