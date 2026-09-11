/**
 * The first turn of an agent that takes over a live call: through the
 * `transfer_agent` builtin, or when a person hands the call back to an agent
 * (options.bridgedTransferToAgent).
 *
 * The caller was greeted when the call started, so the incoming agent does not
 * use its own greeting. It opens from {@link HANDOVER_OPENING_INSTRUCTION} after
 * a handover, or {@link TAKEOVER_OPENING_INSTRUCTION} after a hand-back:
 * natively on Ultravox realtime (`firstSpeakerSettings.agent.prompt`), and as
 * the first-turn `generateReply` on every other stack. The Pipecat worker does
 * the same (agents/pipecat/pipecat_aplisay/transfer_prompts.py).
 */
import { voice } from "@livekit/agents";
import type { UltravoxFirstSpeakerSettings } from "../plugins/ultravox/src/realtime/api_proto.js";
import logger from "./logger.js";
import type { VoiceMode } from "./voice-mode.js";

/**
 * The incoming agent's opening instruction after a `transfer_agent` handover.
 * Byte-identical to HANDOVER_OPENING_INSTRUCTION in the Pipecat worker's
 * transfer_prompts.py, so both workers open a handover the same way. Keep the
 * two in sync; test/handover-opening.test.ts compares them.
 */
export const HANDOVER_OPENING_INSTRUCTION =
  "This is your first message after taking over this call from another " +
  "agent. The caller has already been greeted, so do not greet them as if " +
  "this were a new call, and do not repeat anything the previous agent " +
  "already told them. Introduce yourself in one short sentence. If you have " +
  "a handover summary or the conversation so far, say briefly what you " +
  "understand the caller needs and continue from there. Otherwise ask how " +
  "you can help.";

/**
 * The incoming agent's opening instruction after a person hands the call back
 * (options.bridgedTransferToAgent, see bridged-transfer-to-agent.ts). The
 * caller has been talking with that person since the previous agent left.
 * Byte-identical to TAKEOVER_OPENING_INSTRUCTION in transfer_prompts.py; the
 * same test compares them.
 */
export const TAKEOVER_OPENING_INSTRUCTION =
  "This is your first message after a person handed this call back to you. " +
  "The caller was greeted when the call started and has been talking with " +
  "that person, so do not greet them as if this were a new call. Introduce " +
  "yourself in one short sentence. If you have a summary or the " +
  "conversation so far, say briefly what you understand the caller needs " +
  "or what they agreed with that person, and continue from there. " +
  "Otherwise ask how you can help.";

/**
 * Whether `text` is one of the opening instructions above. A pipeline stack
 * takes its opening as user input, and the SDK records user input as a user
 * turn, so voice-agent-runtime uses this to keep the opening out of the
 * transcript and out of the history carried into a later handover.
 */
export function isOpeningInstruction(text: string): boolean {
  return text === HANDOVER_OPENING_INSTRUCTION || text === TAKEOVER_OPENING_INSTRUCTION;
}

/**
 * Ultravox `firstSpeakerSettings` for a leg that opens from `opening`: the
 * agent speaks first, from that instruction, and can be interrupted. An
 * agent-first opening without a prompt makes Ultravox start the turn with its
 * own "(New Call) Respond as if you are answering the phone." message, which
 * overrides the handover context in the system prompt, so the agent greets the
 * caller as if the call were new. Returns a new object on each call.
 */
export function openingFirstSpeakerSettings(opening: string): UltravoxFirstSpeakerSettings {
  return { agent: { prompt: opening } };
}

/** `generateReply` options that ask for an opening. */
export type OpeningReply =
  | { userInput: string }
  | { instructions: string };

/**
 * The `generateReply` options for `opening` on a stack without a native
 * opening (every stack except Ultravox realtime). Pipeline stacks take it as
 * user input, like the opening greeting, because pipeline
 * `generateReply({ instructions })` is not honoured by every LLM adapter. The
 * SDK records user input as a user turn, so voice-agent-runtime keeps this
 * text out of the transcript (see {@link isOpeningInstruction}).
 */
export function openingReply(voiceMode: VoiceMode, opening: string): OpeningReply {
  return voiceMode === "pipeline" ? { userInput: opening } : { instructions: opening };
}

/**
 * Make the NEXT session created from an Ultravox realtime model open from the
 * handover instruction, through the plugin's one-shot
 * `setNextSessionFirstSpeaker` override (the consult leg in transfer-handler
 * uses the same override).
 *
 * Needed for an in-place handover (`llm.handoff()`). The SDK starts the
 * incoming agent on a new realtime session from the running model, and on
 * Ultravox a new session is a new Ultravox call. Without the override that call
 * opens with the model's own `firstSpeakerSettings`, which were built for the
 * agent the model was created for: its greeting, or an opening with no prompt.
 *
 * Returns false, and changes nothing, when the model has no such override.
 */
export function armHandoverFirstSpeaker(realtimeModel: unknown): boolean {
  const model = realtimeModel as
    | { setNextSessionFirstSpeaker?: (s: UltravoxFirstSpeakerSettings) => void }
    | null
    | undefined;
  if (typeof model?.setNextSessionFirstSpeaker !== "function") {
    return false;
  }
  model.setNextSessionFirstSpeaker(openingFirstSpeakerSettings(HANDOVER_OPENING_INSTRUCTION));
  return true;
}

/**
 * The incoming agent of an in-place `transfer_agent` handover, handed to the
 * SDK through `llm.handoff()`.
 *
 * The SDK calls `onEnter` once the agent's activity has started. A plain
 * `voice.Agent` does nothing there, so the incoming agent said nothing until
 * the caller spoke. Given `opening`, this agent takes its first turn from the
 * handover instruction. Leave `opening` unset on Ultravox realtime, where the
 * opening is native (see {@link armHandoverFirstSpeaker}).
 */
export class HandoverAgent extends voice.Agent {
  readonly #opening?: OpeningReply;

  constructor(options: voice.AgentOptions<any>, opening?: OpeningReply) {
    super(options);
    this.#opening = opening;
  }

  async onEnter(): Promise<void> {
    if (!this.#opening) {
      return;
    }
    try {
      this.session.generateReply(this.#opening);
    } catch (e) {
      logger.warn({ e }, "agent handover: first-turn kick failed");
    }
  }
}
