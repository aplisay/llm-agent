/**
 * Human-to-agent transfers (`options.bridgedTransferToAgent`).
 *
 * After a **bridged** transfer (blind bridge or the bridged finalise of a
 * consultative transfer), the caller is talking to a human transfer target
 * and the AI has left the conversation. `options.bridgedTransferToAgent`
 * lets the *transfer target* hand the caller back to an AI agent by
 * pressing a DTMF sequence:
 *
 *     "options": {
 *       "bridgedTransferToAgent": {
 *         "1":  { "agent": "<uuid>" },
 *         "*7": { "agent": "<uuid>", "includeHistory": false }
 *       }
 *     }
 *
 * While the option is set, transfers are forced onto the bridged path (a
 * SIP REFER would hand the call off-platform, where no DTMF can be
 * observed — see handleTransfer). After the bridge the agent participant
 * stays in the room (muted, media detached) so the job keeps its room
 * connection; this module consumes LiveKit's SIP DTMF room events
 * (`RoomEvent.DtmfReceived`) on that connection, filtered to the
 * transfer-target participant's identity ONLY — the caller's digits never
 * trigger it.
 *
 * On a match the watch (1) reserves a continuation call record (parentId =
 * the original agent call, mirroring the pipecat implementation and
 * docs/call-transfers.md), (2) removes the transfer-target participant and
 * ends the telephony:bridged-call record, and (3) starts the mapped
 * agent's full voice stack on the same room via the runtime's
 * restartWithAgent machinery, with the original agent↔caller conversation
 * embedded in the incoming agent's prompt when `includeHistory` (default
 * true). If the takeover cannot start (target agent at its concurrency
 * limit, misconfigured target), the bridge is left intact — the humans
 * stay connected — and the matcher re-arms so the target can retry.
 *
 * See docs/call-transfers.md ("Human to agent transfers") and the pipecat
 * reference implementation (agents/pipecat/pipecat_aplisay/bridged_transfer.py).
 */

import { RoomEvent } from "@livekit/rtc-node";
import type { RemoteParticipant, Room } from "@livekit/rtc-node";
import logger from "./logger.js";
import { getInternalAgentById } from "./api-client.js";
import type { Agent, Call } from "./api-client.js";
import type { SipParticipant } from "./types.js";

// Matches the server-side validation in lib/database.js — 1-8 chars of the
// keypad symbols RFC 4733 carries end-to-end (A-D are unsupported).
const DTMF_KEY_RE = /^[0-9*#]{1,8}$/;

/** One entry of the bridgedTransferToAgent map, normalised. */
export interface BridgedTransferTarget {
  key: string;
  agentId: string;
  includeHistory: boolean;
}

/**
 * Parse `options.bridgedTransferToAgent` into key → target.
 *
 * The server has already validated + normalised the option (values are
 * `{agent, includeHistory?, fromLabel?}` objects with UUID agents), but be
 * lenient here: skip malformed entries with a log rather than failing the
 * call. Plain-string values are shorthand for `{agent: <string>}`; the
 * `fromLabel` annotation (agent-set label round-tripping) is ignored.
 * Returns null when the option is absent/empty/unusable.
 */
export function parseBridgedTransferMap(
  options: any,
): Map<string, BridgedTransferTarget> | null {
  const raw = options?.bridgedTransferToAgent;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const targets = new Map<string, BridgedTransferTarget>();
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = String(rawKey);
    if (!DTMF_KEY_RE.test(key)) {
      logger.warn({ key }, "bridgedTransferToAgent: ignoring malformed key");
      continue;
    }
    const entry: any =
      typeof rawValue === "string" ? { agent: rawValue } : rawValue;
    const agentId = entry && typeof entry === "object" ? entry.agent : undefined;
    if (!agentId || typeof agentId !== "string") {
      logger.warn(
        { key },
        "bridgedTransferToAgent: ignoring entry without an agent id",
      );
      continue;
    }
    // Static flags arrive as booleans or the legacy "true"/"false" string
    // idiom (cf. transfer_agent's includeHistory); default is true.
    const rawInclude = entry.includeHistory;
    const includeHistory =
      typeof rawInclude === "string"
        ? rawInclude.trim().toLowerCase() !== "false"
        : rawInclude !== false;
    targets.set(key, { key, agentId, includeHistory });
  }
  return targets.size ? targets : null;
}

/**
 * Multi-digit DTMF matcher with inter-digit timeout semantics.
 *
 * Feed digits as they arrive; `onMatch(key)` fires (once) when a configured
 * sequence is recognised:
 *
 * - a buffer that exactly matches a key AND cannot be extended into a
 *   longer key fires immediately;
 * - a buffer that matches a key but is also a prefix of a longer key fires
 *   after `timeoutMs` of keypad silence (giving the longer key a chance);
 * - a buffer that is only a proper prefix resets after `timeoutMs`;
 * - non-matching digits slide out of the buffer (oldest first), so a stray
 *   press doesn't poison a following valid sequence.
 *
 * `timeoutMs` intentionally reuses the platform's DTMF aggregation default
 * (`options.dtmfTimeout`, 1500 ms). Fires once, but re-arms if the match
 * handler rejects (e.g. target agent at its concurrency limit) so a retry
 * press can work while the bridge is still up.
 */
export class DtmfSequenceMatcher {
  private buffer = "";
  private timer: NodeJS.Timeout | null = null;
  private fired = false;

  constructor(
    private readonly keys: string[],
    private readonly onMatch: (key: string) => Promise<void>,
    private readonly timeoutMs: number = 1500,
  ) {}

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  feed(digit: string): void {
    if (this.fired) return;
    this.cancel();
    this.buffer += String(digit);
    // Slide until the buffer is a prefix of at least one key.
    while (
      this.buffer &&
      !this.keys.some((k) => k.startsWith(this.buffer))
    ) {
      this.buffer = this.buffer.slice(1);
    }
    if (!this.buffer) return;
    const exact = this.keys.includes(this.buffer);
    const extendable = this.keys.some(
      (k) => k !== this.buffer && k.startsWith(this.buffer),
    );
    if (exact && !extendable) {
      this.fire(this.buffer);
      return;
    }
    // Exact-but-extendable resolves on timeout to the exact key; a bare
    // prefix resolves on timeout to a reset.
    this.timer = setTimeout(() => this.onTimeout(exact), this.timeoutMs);
  }

  private onTimeout(exact: boolean): void {
    if (this.fired) return;
    const buffer = this.buffer;
    this.buffer = "";
    this.timer = null;
    if (exact && this.keys.includes(buffer)) {
      this.fire(buffer);
    }
  }

  private fire(key: string): void {
    this.fired = true;
    this.buffer = "";
    this.cancel();
    void this.onMatch(key).catch((e) => {
      logger.error(
        { e, key },
        "bridgedTransferToAgent: takeover on DTMF match failed",
      );
      // Allow another attempt if the takeover errored (e.g. target agent at
      // its concurrency limit) — the bridge is still up.
      this.fired = false;
    });
  }
}

/**
 * The live takeover capability the voice runtime registers once its stack
 * is up (see runAgentWorker's registerBridgedTakeover). Kept behind an
 * interface so this module never imports the runtime (no cycle).
 */
export interface BridgedTakeoverRuntime {
  /** Formatted "Caller:/Agent:" transcript of the agent↔caller conversation so far. */
  getConversationHistoryText(): string;
  /**
   * Full agent-stack takeover on the live room (restartWithAgent in
   * takeover mode): reserves the continuation call FIRST (throws on busy,
   * leaving the bridge up), runs `onReserved` once the slot is held, then
   * starts `newAgentDef`'s voice stack talking to the caller.
   */
  takeover(params: {
    newAgentDef: Agent;
    instructions: string;
    /** Field source for the continuation call record (the bridged record). */
    parentCall: Call;
    /** parentId for the continuation record (the original agent call). */
    parentId: string;
    /** Invoked once the continuation slot is reserved — drops the bridge. */
    onReserved: () => Promise<void>;
  }): Promise<void>;
}

/**
 * Compose the incoming agent's system prompt. Mirrors the transfer_agent
 * handover composition and the pipecat reference (compose_takeover_prompt).
 * When the bridged segment was transcribed (`bridgedTransferTranscribe`),
 * the human↔human conversation is carried too; otherwise (with history on)
 * the prompt notes the human segment was not recorded.
 */
export function composeTakeoverPrompt(
  newAgentDef: Agent,
  historyText: string,
  includeHistory: boolean,
  bridgeTranscript: string = "",
): string {
  let prompt = newAgentDef.prompt || "You are a helpful assistant.";
  prompt +=
    "\n\nYou have just taken over a live call. The caller was previously " +
    "speaking with another agent and was then transferred to a human, who " +
    "has now handed the call back to you.";
  if (!includeHistory) {
    prompt += " Treat this as a fresh conversation: disregard any prior context.";
    return prompt;
  }
  if (historyText) {
    prompt +=
      "\n\n# Conversation between the caller and the previous agent\n" +
      historyText;
  }
  if (bridgeTranscript) {
    prompt +=
      "\n\n# Conversation between the caller and the human transfer target\n" +
      bridgeTranscript;
  } else if (historyText) {
    prompt +=
      "\n\n(The conversation the caller had with the human after the " +
      "transfer was not recorded.)";
  }
  return prompt;
}

export interface ArmBridgedTransferWatchParams {
  /** The worker's connected RTC room (ctx.room) — delivers DtmfReceived. */
  room: Room;
  /** Server-side room name, for RoomServiceClient operations. */
  roomName: string;
  /** Identity of the bridged transfer-target SIP participant. ONLY its digits are watched. */
  targetIdentity: string;
  /** The original caller's identity, so the watch dies with either bridged leg. */
  callerIdentity?: string | null;
  targets: Map<string, BridgedTransferTarget>;
  /** Inter-digit timeout (agent options.dtmfTimeout, default 1500ms). */
  dtmfTimeoutMs: number;
  /** The telephony:bridged-call record covering the caller↔target bridge. */
  bridgedCall: Call;
  /** The transferring agent — organisation guard for the target-agent fetch. */
  agent: Agent;
  /** Conversation transcript snapshot captured at bridge time. */
  historyText: string;
  /**
   * Live bridged-segment transcription (`options.bridgedTransferTranscribe`),
   * when armed. Its render() is snapshotted at DTMF-match time so the
   * takeover prompt carries the human↔human conversation; the takeover
   * commit disposes it (the bridge is coming down).
   */
  bridgeTranscription?: {
    render(): string;
    dispose(): void;
  } | null;
  runtime: BridgedTakeoverRuntime;
  setBridgedParticipant: (p: SipParticipant | null) => void;
  setBridgedCallRecord: (call: Call | null) => void;
  /**
   * Hangs up a participant (RoomServiceClient.removeParticipant), injected by
   * the transfer handler so this module carries no client of its own.
   */
  removeParticipant: (roomName: string, identity: string) => Promise<unknown>;
}

/**
 * Arm the post-bridge DTMF watch: subscribe to the room's SIP DTMF events,
 * run the sequence matcher over the transfer target's presses, and on a
 * match perform the human→agent takeover. Returns a disposer; the watch
 * also disposes itself when the caller or target disconnects or the room
 * connection drops.
 */
export function armBridgedTransferWatch(
  params: ArmBridgedTransferWatchParams,
): () => void {
  const {
    room,
    roomName,
    targetIdentity,
    callerIdentity,
    targets,
    dtmfTimeoutMs,
    bridgedCall,
    agent,
    historyText,
    bridgeTranscription,
    runtime,
    setBridgedParticipant,
    setBridgedCallRecord,
    removeParticipant,
  } = params;

  let disposed = false;
  // Set once a match commits to bringing the bridge down, so our own
  // removeParticipant on the target doesn't dispose the in-flight takeover.
  let takingOver = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    matcher.cancel();
    room.off(RoomEvent.DtmfReceived, onDtmf);
    room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    room.off(RoomEvent.Disconnected, onRoomDisconnected);
    logger.debug(
      { roomName, targetIdentity },
      "bridgedTransferToAgent: DTMF watch disposed",
    );
  };

  const onMatch = async (key: string): Promise<void> => {
    const target = targets.get(key);
    if (!target || disposed) return;
    logger.info(
      { key, agentId: target.agentId, bridgedCallId: bridgedCall.id },
      "bridgedTransferToAgent: DTMF match — starting takeover",
    );
    takingOver = true;
    try {
      // Resolve the mapped agent (same-organisation guard) and validate it
      // can take over a live LiveKit call. Any throw from here leaves the
      // humans talking: the matcher logs and re-arms for a retry press.
      const newAgentDef = await getInternalAgentById(
        target.agentId,
        agent.organisationId,
      );
      if ((newAgentDef.type ?? "interactive-audio") !== "interactive-audio") {
        throw new Error(
          `bridgedTransferToAgent target ${target.agentId} is type ${newAgentDef.type} and cannot take over a live call`,
        );
      }
      const targetModelName = newAgentDef.modelName || "";
      if (targetModelName.split(":")[0] !== "livekit") {
        throw new Error(
          `bridgedTransferToAgent target ${target.agentId} uses ${targetModelName}; a live LiveKit call can only be taken over by a livekit: agent`,
        );
      }

      // Snapshot the human↔human transcript NOW — the collector stops (and
      // the bridge comes down) as the takeover commits.
      const bridgeTranscript = bridgeTranscription?.render() ?? "";
      const instructions = composeTakeoverPrompt(
        newAgentDef,
        historyText,
        target.includeHistory,
        bridgeTranscript,
      );

      await runtime.takeover({
        newAgentDef,
        instructions,
        parentCall: bridgedCall,
        // Child of the original agent call (the bridged record's parent) —
        // matches the pipecat implementation and docs/call-transfers.md
        // ("parentId linking back to the original call").
        parentId: bridgedCall.parentId || bridgedCall.id,
        onReserved: async () => {
          // The continuation slot is held: commit. Clear the bridged state
          // FIRST so the runtime's ParticipantDisconnected handler doesn't
          // treat the target removal as end-of-call, then drop the target
          // and close the bridged record. Best-effort — from here the
          // takeover proceeds regardless.
          setBridgedParticipant(null);
          setBridgedCallRecord(null);
          // Stop the bridged-segment transcription before the target is
          // removed (the transcript snapshot was taken at match time).
          try {
            bridgeTranscription?.dispose();
          } catch (e) {
            logger.warn(
              { e },
              "bridgedTransferToAgent: bridge transcription dispose failed",
            );
          }
          try {
            await removeParticipant(roomName, targetIdentity);
          } catch (e) {
            logger.warn(
              { e, roomName, targetIdentity },
              "bridgedTransferToAgent: transfer target removal failed (may already be gone)",
            );
          }
          await bridgedCall
            .end(`Transfer target handed call back to agent ${newAgentDef.id}`)
            .catch((e) => {
              logger.error(
                { e, bridgedCallId: bridgedCall.id },
                "bridgedTransferToAgent: failed to end bridged call record",
              );
            });
        },
      });
      dispose();
    } catch (e) {
      takingOver = false;
      throw e; // DtmfSequenceMatcher logs and re-arms
    }
  };

  const matcher = new DtmfSequenceMatcher(
    [...targets.keys()],
    onMatch,
    dtmfTimeoutMs,
  );

  const onDtmf = (
    _code: number,
    digit: string,
    participant: RemoteParticipant,
  ): void => {
    if (disposed) return;
    // The transfer target ONLY — the caller's digits must never trigger a takeover.
    if (participant?.identity !== targetIdentity) return;
    logger.debug(
      { digit, identity: participant.identity },
      "bridgedTransferToAgent: DTMF from transfer target",
    );
    matcher.feed(digit);
  };

  const onParticipantDisconnected = (p: RemoteParticipant): void => {
    if (disposed || takingOver) return;
    const identity = p?.identity ?? (p as any)?.info?.identity;
    if (
      identity === targetIdentity ||
      (callerIdentity && identity === callerIdentity)
    ) {
      logger.info(
        { identity, roomName },
        "bridgedTransferToAgent: bridged leg disconnected, disposing DTMF watch",
      );
      dispose();
    }
  };

  const onRoomDisconnected = (): void => {
    dispose();
  };

  room.on(RoomEvent.DtmfReceived, onDtmf);
  room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
  room.on(RoomEvent.Disconnected, onRoomDisconnected);

  logger.info(
    {
      roomName,
      targetIdentity,
      keys: [...targets.keys()].sort(),
      dtmfTimeoutMs,
      bridgedCallId: bridgedCall.id,
    },
    "bridgedTransferToAgent: post-bridge DTMF watch armed",
  );
  return dispose;
}
