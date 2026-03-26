export type FunctionHandlerOptions = {
  allowToolsCallsMetadataPaths?: boolean;
  allowRedactedFunctionResults?: boolean;
};

export function functionHandler(
  function_calls: any,
  functions: any,
  keys: any,
  messageHandler: any,
  metadata: any,
  specficBuiltins?: any,
  options?: FunctionHandlerOptions,
): Promise<any>;

