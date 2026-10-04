// The spec's default post-call question set as a decision agent's result schema, and the recorded
// vendor exchange for it (six-questions.json). Shared by the decision-model tests.
import { readFileSync } from 'node:fs';

export const fixture = (name) => JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8'));

export const SIX_PROPERTIES = {
  outcome: {
    type: 'string', description: 'How did the call end for the caller?',
    enum: ['resolved', 'partially_resolved', 'unresolved', 'transferred', 'abandoned', 'wrong_number'],
    'x-descriptions': {
      resolved: 'The caller got what they called for',
      transferred: 'The call was handed to a person or another agent',
      abandoned: 'The caller gave up or hung up before the matter was dealt with',
    },
  },
  needs_followup: { type: 'boolean', description: 'Does someone need to contact this caller again?' },
  caller_sentiment: { type: 'string', description: "The caller's tone by the end of the call", 'x-levels': ['angry', 'frustrated', 'neutral', 'satisfied', 'delighted'] },
  agent_error: { type: 'boolean', description: 'Did the agent give wrong or misleading information?' },
  policy_breach: { type: 'boolean', description: 'Did the agent do something its instructions forbid?' },
  escalation_missed: {
    type: 'boolean', description: 'Did the caller ask for a human and not get one?',
    'x-criteria': { true: 'The caller asked for a person and the call ended without a transfer', false: 'No request for a person, or the caller was transferred' },
  },
};

export const resultFunction = (properties = SIX_PROPERTIES, name = 'analyse') => ({
  name, implementation: 'builtin', platform: 'result', description: 'The answers',
  input_schema: { type: 'object', properties },
});

export const SIX = fixture('six-questions');
