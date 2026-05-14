import { llm } from "@livekit/agents";
import logger from "./logger.js";
import { functionHandler } from "../agent-lib/function-handler.js";
import type { Agent, AgentFunction, Call, CallMetadata } from "./api-client.js";
import type { MessageData, TransferArgs, FunctionResult } from "./types.js";
import type { Room } from "@livekit/rtc-node";
import type { ParticipantInfo } from "./types.js";

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
