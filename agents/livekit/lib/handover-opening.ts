/**
 * The first turn of an agent that takes over a live call through the
 * `transfer_agent` builtin.
 *
 * The caller was greeted when the call started, so the incoming agent does not
 * use its own greeting. It opens from {@link HANDOVER_OPENING_INSTRUCTION}:
 * natively on Ultravox realtime (`firstSpeakerSettings.agent.prompt`), and as
 * the first-turn `generateReply` on every other stack. The Pipecat worker does
 * the same (agents/pipecat/pipecat_aplisay/transfer_prompts.py).
 *
 * A human hand-back to an agent (options.bridgedTransferToAgent) does not use
 * this: that agent still greets the caller.
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
 * Ultravox `firstSpeakerSettings` for a handover leg: the agent speaks first,
 * from the handover instruction, and can be interrupted. An agent-first opening
 * without a prompt makes Ultravox start the turn with its own "(New Call)
 * Respond as if you are answering the phone." message, which overrides the
 * handover context in the system prompt, so the agent greets the caller as if
 * the call were new. Returns a new object on each call.
 */
export function handoverFirstSpeakerSettings(): UltravoxFirstSpeakerSettings {
  return { agent: { prompt: HANDOVER_OPENING_INSTRUCTION } };
}

/** `generateReply` options that ask for the handover opening. */
export type HandoverOpeningReply =
  | { userInput: string }
  | { instructions: string };

/**
 * The `generateReply` options for the handover opening on a stack without a
 * native one (every stack except Ultravox realtime). Pipeline stacks take it as
 * user input, like the opening greeting, because pipeline
 * `generateReply({ instructions })` is not honoured by every LLM adapter. The
 * SDK records user input as a user turn, so voice-agent-runtime keeps this text
 * out of the transcript.
 */
export function handoverOpeningReply(voiceMode: VoiceMode): HandoverOpeningReply {
  return voiceMode === "pipeline"
    ? { userInput: HANDOVER_OPENING_INSTRUCTION }
    : { instructions: HANDOVER_OPENING_INSTRUCTION };
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
  model.setNextSessionFirstSpeaker(handoverFirstSpeakerSettings());
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
  readonly #opening?: HandoverOpeningReply;

  constructor(options: voice.AgentOptions<any>, opening?: HandoverOpeningReply) {
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
