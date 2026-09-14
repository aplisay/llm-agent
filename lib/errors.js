/**
 * Propagate infrastructure failures to abort the turn; ordinary builtin errors become tool results the model can
 * correct. See PR #118.
 */
export class InfrastructureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InfrastructureError';
  }
}
