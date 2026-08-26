import { maskInternalIds, maskToolResultIds } from '../lib/mask-ids.js';

// Internal ids are platform plumbing and must never reach a user. The prompt
// has said so since 0146c4e, but a prompt is guidance and a tool result is
// evidence: a builder session whose placeholder set had been deleted
// mid-conversation relayed the tool error word for word —
//
//   I couldn't save the name because the supplied placeholder set could not be
//   found: "Agent set <uuid> not found." Please reopen or refresh the team,
//   and I'll continue building into that same set.
//
// These pin the invariant that closes it at the source: the model never
// RECEIVES the id, so it has nothing to quote. What it must still receive is
// the failure itself, and a successful save's ids, which it needs to build.

const ID = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
/** Nothing shaped like an id we mint may survive. */
const ID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('maskInternalIds', () => {
  // One entry per shape a tool error has been seen to carry an id in. A new
  // thrower that dodges these is still caught by the ID_SHAPE assertion.
  const MESSAGES = [
    ['the incident, from agent-set-service', `Agent set ${ID} not found`],
    ['the sibling thrower', `Agent set ${ID} not found`],
    ['uppercase', `Agent set ${ID.toUpperCase()} not found`],
    ['parenthesised', `The team (${ID}) could not be updated`],
    ['quoted', `The set "${ID}" is gone`],
    ['two in one message', `Agent ${OTHER} does not belong to set ${ID}`],
    ['a labelled field', `id: ${ID}`],
  ];

  test.each(MESSAGES)('removes the id from %s', (_name, message) => {
    expect(maskInternalIds(message)).not.toMatch(ID_SHAPE);
  });

  test('leaves a readable sentence, not punctuation debris', () => {
    // A mask that shredded the message would be worse than the leak: the model
    // still has to understand the failure to act on it.
    expect(maskInternalIds(`Agent set ${ID} not found`)).toBe('Agent set not found');
    expect(maskInternalIds(`The team (${ID}) could not be updated`)).toBe(
      'The team could not be updated',
    );
    expect(maskInternalIds(`The set "${ID}" is gone`)).toBe('The set is gone');
  });

  test('leaves text with no ids in it byte-identical', () => {
    const clean = 'label "reception" is not a member of this set';
    expect(maskInternalIds(clean)).toBe(clean);
  });

  test('passes non-strings through', () => {
    expect(maskInternalIds(undefined)).toBeUndefined();
    expect(maskInternalIds(null)).toBeNull();
    expect(maskInternalIds('')).toBe('');
  });
});

describe('maskToolResultIds', () => {
  test('masks the error a failed save hands back to the model', () => {
    const masked = maskToolResultIds(JSON.stringify({ error: `Agent set ${ID} not found` }));
    expect(masked).not.toMatch(ID_SHAPE);
    expect(JSON.parse(masked).error).toBe('Agent set not found');
  });

  test('keeps every other field of the failure', () => {
    const masked = maskToolResultIds(JSON.stringify({ error: `Agent set ${ID} not found`, retryable: false }));
    expect(JSON.parse(masked)).toEqual({ error: 'Agent set not found', retryable: false });
  });

  test('leaves a SUCCESSFUL save alone — those ids are the model\'s to use', () => {
    // slimResults hands back the post-save set and member ids precisely so
    // test_agent can resolve a label to an agent. Masking them breaks the build.
    const saved = JSON.stringify({ id: ID, name: 'Reception', agents: [{ label: 'front', id: OTHER }] });
    expect(maskToolResultIds(saved)).toBe(saved);
  });

  test('leaves a non-JSON result alone', () => {
    const plain = `Agent set ${ID} not found`;
    expect(maskToolResultIds(plain)).toBe(plain);
  });

  test('leaves a clean error untouched rather than reserialising it', () => {
    const clean = JSON.stringify({ error: 'label "reception" is not a member of this set' });
    expect(maskToolResultIds(clean)).toBe(clean);
  });
});
