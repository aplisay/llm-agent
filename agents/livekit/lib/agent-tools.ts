import { llm } from "@livekit/agents";
import type { voice } from "@livekit/agents";
import logger from "./logger.js";
import {
  logToolCall,
  logToolLoop,
  logToolResult,
  type ToolKind,
} from "./tool-log.js";
import {
  createToolLoopBreaker,
  isLoopExempt,
  TOOL_LOOP_WINDOW_MS,
} from "./tool-loop-breaker.js";
import { functionHandler } from "../agent-lib/function-handler.js";
import { invokeSubagent } from "./api-client.js";
import type { Agent, AgentFunction, Call, CallMetadata } from "./api-client.js";
import type {
  MessageData,
  TransferArgs,
  FunctionResult,
  HangupResult,
} from "./types.js";
import type { Room } from "@livekit/rtc-node";
import type { ParticipantInfo } from "./types.js";

/** Resolved arguments of a builtin transfer_agent platform function call. */
export interface AgentTransferArgs {
  agent: string;
  includeHistory?: boolean;
  summary?: string;
}

/**
 * Creates tools for the agent based on the agent's functions configuration
 */
export function createTools({
  agent,
  call,
  room,
  participant,
  sendMessage,
  metadata,
  onHangup,
  onTransfer,
  getTransferState,
  onAgentTransfer,
  onSendDtmf,
  onToolLoopDetected,
}: {
  agent: Agent;
  call: Call;
  room: Room;
  participant: ParticipantInfo | null;
  sendMessage: (message: MessageData, createdAt?: Date) => Promise<void>;
  metadata: CallMetadata;
  /**
   * Requests agent-initiated termination. Resolves with the result handed to
   * the model — never void, and never empty (see HangupResult). Repeat calls
   * while a hangup is already in flight resolve with an explicit
   * "already in progress" detail rather than silently re-arming teardown.
   */
  onHangup: () => Promise<HangupResult>;
  onTransfer: ({
    args,
    participant,
  }: {
    args: TransferArgs;
    participant: ParticipantInfo;
  }) => Promise<ParticipantInfo>;
  getTransferState: () => {
    state: "none" | "dialling" | "talking" | "rejected" | "failed";
    description: string;
  };
  /**
   * Performs an in-call agent-to-agent handover. For an in-place (same-model)
   * swap it returns the new voice.Agent, honoured here via llm.handoff(); for
   * a full-stack handover (model change, child call record) the restart has
   * already happened by the time it resolves and no handoff is returned.
   */
  onAgentTransfer?: (
    args: AgentTransferArgs,
  ) => Promise<{ handoffAgent?: voice.Agent; detail: string }>;
  /**
   * Plays a string of DTMF digits to the caller as out-of-band (RFC 4733)
   * tones via localParticipant.publishDtmf. Returns a `{status, ...}` result
   * (FAILED on a WebRTC session or a bad digit string) rather than throwing,
   * so the LLM gets a clean tool result — mirrors the transfer builtins.
   */
  onSendDtmf?: (args: {
    digits: string;
  }) => Promise<{ status: string; detail?: string; error?: string }>;
  /**
   * Called when a tool breaches the runaway-loop kill threshold. The runtime
   * wires this to a forced teardown: at that point the model has demonstrated
   * it will not stop, and every further second is billed on both legs.
   */
  onToolLoopDetected?: (info: {
    tool: string;
    calls: number;
    windowMs: number;
  }) => void;
}): llm.ToolContext {
  const { functions = [], keys = [] } = agent;

  // Runaway-loop breaker, created once per createTools() call — i.e. once per
  // agent stack — so counts do not leak across calls or survive an agent
  // handover. Policy and thresholds live in ./tool-loop-breaker.ts.
  const noteCallAndCheckLoop = createToolLoopBreaker();
  // Teardown is requested once; further refused calls in the window before the
  // session actually comes down must not re-fire it or spam the error log.
  let toolLoopKilled = false;

  return (
    functions &&
    (functions.reduce(
      (acc: llm.ToolContext, fnc: AgentFunction) => ({
        ...acc,
        [fnc.name]: llm.tool({
          description: fnc.description,
          parameters: (() => {
            // Expose to the model exactly the parameters the function handler
            // does NOT resolve itself. The handler injects `source: "static"`
            // (from `from`) and `source: "metadata"` values post-dispatch; every
            // other parameter — INCLUDING one with no `source` at all — is
            // model-provided by convention (see function-handler.js and
            // lib/subagent.js `llmFunctions`). The previous `=== "generated"`
            // filter dropped no-source params, so e.g. a subagent's `question`
            // was neither exposed here nor injected by the handler and silently
            // vanished (Ultravox stripped the value the model still sent).
            const exposed = Object.entries(fnc.input_schema.properties || {}).filter(
              ([, value]: [string, any]) =>
                value.source !== "static" && value.source !== "metadata",
            );
            // `required` may be a JSON-Schema top-level array or a per-property
            // `required: true` flag — honour both, but only for exposed params.
            const topLevelRequired: string[] = Array.isArray(
              fnc.input_schema.required,
            )
              ? fnc.input_schema.required
              : [];
            return {
              type: "object",
              properties: Object.fromEntries(
                exposed.map(([key, value]: [string, any]) => [
                  key,
                  { ...value, required: undefined },
                ]),
              ),
              required: exposed
                .filter(
                  ([key, value]: [string, any]) =>
                    topLevelRequired.includes(key) || value.required,
                )
                .map(([key]) => key),
            };
          })(),
          execute: async (args: unknown) => {
            // Coarse tool classification for the InvocationLog. The livekit
            // voice worker executes only the agent's own `functions`/builtins
            // (MCP tools are proxied by the pipecat worker, not here), so a
            // tool is a user function or a platform builtin — and the `subagent`
            // builtin (delegation to a headless text agent) is split out as its
            // own kind so agent-to-agent calls read distinctly in the debug log.
            const kind: ToolKind =
              fnc.platform === "subagent"
                ? "subagent"
                : fnc.implementation === "builtin"
                  ? "builtin"
                  : "function";
            const startedAt = Date.now();
            // INFO-level, event-tagged so every tool call is visible in the
            // per-call debug log for production agents (see ./tool-log.ts).
            logToolCall(logger, { tool: fnc.name, kind, args });

            // Runaway-loop breaker. Checked BEFORE dispatch so a spinning model
            // cannot keep re-entering the tool body, and after logToolCall so
            // the refused attempts still appear in the debug log rather than
            // vanishing from the record of what the model actually did.
            // Poll-by-design builtins are counted but never refused or killed.
            const loop = noteCallAndCheckLoop(fnc.name, isLoopExempt(fnc));
            if (loop.hot) {
              // Diagnostic only: the tool still runs. Emitted once per hot
              // spell so a legitimate poll cannot flood the size-bounded
              // InvocationLog, while an unexpectedly hot poll stays visible.
              logToolLoop(logger, {
                tool: fnc.name,
                kind,
                calls: loop.calls,
                windowMs: TOOL_LOOP_WINDOW_MS,
                action: "exempt",
              });
            }
            if (loop.refuse) {
              const kill = loop.kill && !toolLoopKilled;
              logToolLoop(logger, {
                tool: fnc.name,
                kind,
                calls: loop.calls,
                windowMs: TOOL_LOOP_WINDOW_MS,
                action: kill ? "terminated" : "refused",
              });
              if (kill) {
                toolLoopKilled = true;
                onToolLoopDetected?.({
                  tool: fnc.name,
                  calls: loop.calls,
                  windowMs: TOOL_LOOP_WINDOW_MS,
                });
              }
              const error = `tool "${fnc.name}" has been called ${loop.calls} times in the last ${
                Math.round(TOOL_LOOP_WINDOW_MS / 1000)
              } seconds and is being rate limited. Do not call it again. Continue the conversation, or say nothing.`;
              logToolResult(logger, {
                tool: fnc.name,
                kind,
                ok: false,
                error,
                durationMs: Date.now() - startedAt,
              });
              // Returned (not thrown) so the model receives it as this tool's
              // result and can act on it, mirroring the builtin failure path.
              return JSON.stringify({ status: "FAILED", error });
            }

            try {
              // A builtin transfer_agent performs its handover INSIDE the
              // handler below (not after functionHandler returns) so the result
              // the shared handler records and emits — the persisted tool
              // result and the userland transcript — is the true outcome: a
              // busy/concurrency rejection is reported as a failure rather than
              // an optimistic "handing the caller over". On success the resolved
              // handover is stashed so this tool can still return llm.handoff().
              let pendingHandoff: {
                handoffAgent?: voice.Agent;
                detail: string;
              } | null = null;
              let result = (await functionHandler(
                [{ ...fnc, input: args }],
                functions,
                keys,
                sendMessage,
                metadata,
                {
                  // Returns onHangup's result verbatim: the model must be told
                  // the hangup was accepted, otherwise it reads the empty
                  // result as a failure and immediately retries.
                  hangup: async () => await onHangup(),
                  transfer: async (a: TransferArgs) =>
                    await onTransfer({ args: a, participant: participant! }),
                  transfer_status: async () => {
                    const state = getTransferState();
                    logger.debug({ state }, "transfer_status called");
                    return {
                      state: state.state,
                      description: state.description,
                    };
                  },
                  ...(onAgentTransfer && {
                    transfer_agent: async (a: AgentTransferArgs) => {
                      let handover: {
                        handoffAgent?: voice.Agent;
                        detail: string;
                      };
                      try {
                        handover = await onAgentTransfer(a);
                      } catch (e) {
                        const message = (e as Error).message;
                        logger.info(
                          { error: message, args: a, callId: call.id },
                          "transfer_agent failed",
                        );
                        // Return a FAILED result (don't throw) so the shared
                        // handler records the failure as THIS tool's result:
                        // the handover never happened, so the caller must not
                        // be told it succeeded. Shape matches the pipecat
                        // transfer handler and the documented contract, so a
                        // failed handover looks identical across platforms.
                        return {
                          status: "FAILED",
                          error: `could not transfer to the requested agent: ${message}`,
                          reason: message,
                        };
                      }
                      pendingHandoff = handover;
                      logger.info(
                        {
                          from: agent.id,
                          to: a.agent,
                          callId: call.id,
                          mode: handover.detail,
                        },
                        "transfer_agent: handing session to new agent",
                      );
                      return {
                        status: "OK",
                        detail: "handing the caller over to the new agent",
                      };
                    },
                  }),
                  subagent: async (a: Record<string, unknown>) => {
                    const { agent: targetAgentId, ...input } = a;
                    return await invokeSubagent(
                      String(targetAgentId),
                      input,
                      metadata,
                      { organisationId: agent.organisationId, callId: call.id },
                    );
                  },
                  ...(onSendDtmf && {
                    send_dtmf: async (a: { digits: string }) =>
                      await onSendDtmf(a),
                  }),
                },
                {
                  allowToolsCallsMetadataPaths: true,
                  allowRedactedFunctionResults: true,
                },
              )) as FunctionResult;
              let { function_results } = result;
              let [{ result: data, error }] = function_results;
              // Emit the matching tool_result BEFORE any early return so it is
              // recorded for every outcome, including an agent handover. `data`
              // is the result the model sees (already redacted for `redact`
              // functions), so nothing sensitive is added to the log here.
              logToolResult(logger, {
                tool: fnc.name,
                kind,
                ok: !error,
                result: data,
                error: error ?? undefined,
                durationMs: Date.now() - startedAt,
              });
              if (pendingHandoff) {
                const { handoffAgent } = pendingHandoff;
                if (handoffAgent) {
                  // In-place swap: hand the live session to the new agent.
                  return llm.handoff({ agent: handoffAgent, returns: data });
                }
                // Full-stack handover: the outgoing session is already being
                // replaced; this result has no LLM left to speak it.
                return data;
              }
              return data;
            } catch (e) {
              const message = (e as Error).message;
              logToolResult(logger, {
                tool: fnc.name,
                kind,
                ok: false,
                error: message,
                durationMs: Date.now() - startedAt,
              });
              throw new Error(`error executing function: ${message}`);
            }
          },
        }),
      }),
      {},
    ) as llm.ToolContext)
  );
}
