import { callRedactionReady, notRedacted } from '../lib/redacted-calls.js';
import { stepOff } from '../lib/schema-guards.js';

describe('redacted call filter', () => {
  test('hides redacted calls once schema 78 is there, and filters nothing before it', () => {
    expect(callRedactionReady()).toBe(true);
    expect(notRedacted()).toEqual({ redactedAt: null });
    stepOff('callRedaction');
    expect(callRedactionReady()).toBe(false);
    expect(notRedacted()).toEqual({});
  });
});
