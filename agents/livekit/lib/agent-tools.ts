import { llm } from "@livekit/agents";
import type { voice } from "@livekit/agents";
import logger from "./logger.js";
import { functionHandler } from "../agent-lib/function-handler.js";
import { invokeSubagent } from "./api-client.js";
import type { Agent, AgentFunction, Call, CallMetadata } from "./api-client.js";
import type { MessageData, TransferArgs, FunctionResult } from "./types.js";
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
}: {
  agent: Agent;
  call: Call;
  room: Room;
  participant: ParticipantInfo | null;
  sendMessage: (message: MessageData, createdAt?: Date) => Promise<void>;
  metadata: CallMetadata;
  onHangup: () => Promise<void>;
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
   * Performs an in-call agent-to-agent handover: resolves the target agent
   * definition and returns the new voice.Agent to hand the session to.
   * When provided, builtin `transfer_agent` functions are honoured by
   * returning an llm.handoff() from the tool execution.
   */
  onAgentTransfer?: (args: AgentTransferArgs) => Promise<voice.Agent>;
}): llm.ToolContext {
  const { functions = [], keys = [] } = agent;

  return (
    functions &&
    (functions.reduce(
      (acc: llm.ToolContext, fnc: AgentFunction) => ({
        ...acc,
        [fnc.name]: llm.tool({
          description: fnc.description,
          parameters: {
            type: "object",
            properties: Object.fromEntries(
              Object.entries(fnc.input_schema.properties)
                .filter(([, value]) => value.source === "generated")
                .map(([key, value]: [string, any]) => [
                  key,
                  { ...value, required: undefined },
                ]),
            ),
            required:
              Object.keys(fnc.input_schema.properties).filter(
                (key) => fnc.input_schema.properties[key].required,
              ) || [],
          },
          execute: async (args: unknown) => {
            try {
              logger.debug(
                { name: fnc.name, args, fnc },
                `Got function call ${fnc.name}`,
              );
              // Set when a builtin transfer_agent function fires: the handover
              // itself happens after functionHandler returns, so the resolved
              // (static/metadata) parameters come from the shared handler but
              // the tool can still return an llm.handoff() to the session.
              let pendingAgentTransfer: AgentTransferArgs | null = null;
              let result = (await functionHandler(
                [{ ...fnc, input: args }],
                functions,
                keys,
                sendMessage,
                metadata,
                {
                  hangup: () => onHangup(),
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
                      pendingAgentTransfer = a;
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
                },
                {
                  allowToolsCallsMetadataPaths: true,
                  allowRedactedFunctionResults: true,
                },
              )) as FunctionResult;
              let { function_results } = result;
              let [{ result: data, error }] = function_results;
              if (error) {
                logger.info(
                  { data, error, agentId: agent.id, callId: call.id },
                  "error executing function",
                );
              }
              if (pendingAgentTransfer && onAgentTransfer) {
                try {
                  const newAgent = await onAgentTransfer(pendingAgentTransfer);
                  logger.info(
                    {
                      from: agent.id,
                      to: (pendingAgentTransfer as AgentTransferArgs).agent,
                      callId: call.id,
                    },
                    "transfer_agent: handing session to new agent",
                  );
                  return llm.handoff({ agent: newAgent, returns: data });
                } catch (e) {
                  const message = (e as Error).message;
                  logger.info(
                    { error: message, args: pendingAgentTransfer },
                    "transfer_agent failed",
                  );
                  return `FAILED - could not transfer to the requested agent: ${message}`;
                }
              }
              logger.debug(
                { data },
                `function execute returning ${JSON.stringify(data)}`,
              );
              return data;
            } catch (e) {
              const message = (e as Error).message;
              logger.info({ error: message }, "error executing function");
              throw new Error(`error executing function: ${message}`);
            }
          },
        }),
      }),
      {},
    ) as llm.ToolContext)
  );
}
