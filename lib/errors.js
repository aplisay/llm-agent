/**
 * Shared error taxonomy for the function handler and its builtins.
 *
 * An `InfrastructureError` marks a failure the calling model CANNOT fix by
 * retrying: a missing service configuration (e.g. `SERVICE_BASE_URI`), a builtin
 * that isn't wired into the current runtime/context, or a disallowed access
 * path. The function handler lets these propagate and abort the turn so the
 * misconfiguration surfaces (in logs / to the operator), rather than feeding the
 * model a tool-result error it can do nothing useful with.
 *
 * Ordinary `Error`s thrown by a builtin are treated as model-fixable (bad
 * arguments, wrong shape, a validation failure on a document the model
 * assembled) and are returned to the model as the tool result so it can read the
 * message, correct the call and retry — instead of aborting the whole turn.
 */
export class InfrastructureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InfrastructureError';
  }
}
