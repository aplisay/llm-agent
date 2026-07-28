import {
  promptWithMetadata,
  resolvePromptMetadataLines,
  PROMPT_METADATA_HEADING,
  MAX_VALUE_CHARS,
} from '../lib/prompt-metadata.js';
import { validatePromptMetadata } from '../lib/prompt-metadata-validate.js';

/**
 * `promptMetadata` — call metadata stated in the system prompt instead of
 * fetched with a tool call (docs/prompt-metadata.md).
 *
 * Pins the semantics every worker must share: live dateTime, omission of
 * absent values (never "undefined" in a prompt), untouched prompt when nothing
 * resolves, and the toolsCalls capability gate that stops promptMetadata being
 * a way around the `source: "metadata"` rule.
 */

const METADATA = {
  aplisay: { callerId: '+447700900123', calledId: '+441234567890', callId: 'c-1' },
  crm: { tier: 'gold', openTickets: 2, contact: { name: 'Bob' } },
};

const dateTimeRe = /^\w+day \d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+$/;

describe('resolvePromptMetadataLines', () => {
  it('renders "<description> <value>" per entry, in declaration order', () => {
    const lines = resolvePromptMetadataLines(
      [
        { description: 'The number this caller is calling from is', from: 'aplisay.callerId' },
        { description: 'They dialled', from: 'aplisay.calledId' },
      ],
      METADATA,
    );
    expect(lines).toEqual([
      'The number this caller is calling from is +447700900123',
      'They dialled +441234567890',
    ]);
  });

  it('computes aplisay.dateTime live, and lets a seeded value win', () => {
    const [live] = resolvePromptMetadataLines([{ from: 'aplisay.dateTime' }], METADATA);
    expect(live).toMatch(dateTimeRe);

    const seeded = resolvePromptMetadataLines([{ from: 'aplisay.dateTime' }], {
      aplisay: { dateTime: 'SEEDED' },
    });
    expect(seeded).toEqual(['SEEDED']);
  });

  it('OMITS entries whose value is missing, null or blank — never states "undefined"', () => {
    const lines = resolvePromptMetadataLines(
      [
        { description: 'Account tier is', from: 'crm.tier' },
        { description: 'Loyalty number is', from: 'crm.loyaltyNumber' },
        { description: 'Agent alias is', from: 'nothing.here.at.all' },
        { description: 'Blank is', from: 'crm.blank' },
      ],
      { ...METADATA, crm: { ...METADATA.crm, blank: '   ' } },
    );
    expect(lines).toEqual(['Account tier is gold']);
    expect(lines.join('\n')).not.toMatch(/undefined|null/);
  });

  it('renders numbers, nested paths and structured values usefully', () => {
    const lines = resolvePromptMetadataLines(
      [
        { description: 'Open tickets:', from: 'crm.openTickets' },
        { description: 'Contact name is', from: 'crm.contact.name' },
        { description: 'Contact record:', from: 'crm.contact' },
      ],
      METADATA,
    );
    expect(lines).toEqual(['Open tickets: 2', 'Contact name is Bob', 'Contact record: {"name":"Bob"}']);
  });

  it('caps a large value so a seeded blob cannot crowd out the prompt', () => {
    const [line] = resolvePromptMetadataLines([{ from: 'big' }], { big: 'x'.repeat(5000) });
    expect(line.length).toBeLessThanOrEqual(MAX_VALUE_CHARS + 1);
  });

  it('is inert for absent/empty/malformed declarations', () => {
    expect(resolvePromptMetadataLines(undefined, METADATA)).toEqual([]);
    expect(resolvePromptMetadataLines([], METADATA)).toEqual([]);
    expect(resolvePromptMetadataLines([{ description: 'no from' }, null, 'x'], METADATA)).toEqual([]);
  });
});

describe('promptWithMetadata', () => {
  it('appends the resolved block under the heading, after the agent prompt', () => {
    const out = promptWithMetadata('You are a booking agent.', [{ description: 'Today is', from: 'aplisay.dateTime' }], METADATA);
    expect(out.startsWith('You are a booking agent.')).toBe(true);
    expect(out).toContain(PROMPT_METADATA_HEADING);
    expect(out.split('\n').pop()).toMatch(/^Today is /);
  });

  it('returns the prompt byte-identical when nothing resolves', () => {
    const prompt = 'You are a helpful assistant.';
    expect(promptWithMetadata(prompt, undefined, METADATA)).toBe(prompt);
    expect(promptWithMetadata(prompt, [], METADATA)).toBe(prompt);
    expect(promptWithMetadata(prompt, [{ from: 'not.present' }], METADATA)).toBe(prompt);
  });

  it('still produces the block when the agent has no prompt of its own', () => {
    const out = promptWithMetadata('', [{ description: 'Caller:', from: 'aplisay.callerId' }], METADATA);
    expect(out).toBe(`${PROMPT_METADATA_HEADING}\nCaller: +447700900123`);
  });
});

describe('validatePromptMetadata', () => {
  const dynamic = { hasDynamicMetadata: true };
  const plain = {};

  it('accepts a well-formed declaration and an absent one', () => {
    expect(() => validatePromptMetadata({ Handler: plain, promptMetadata: undefined })).not.toThrow();
    expect(() =>
      validatePromptMetadata({
        Handler: plain,
        promptMetadata: [{ description: 'The current date/time is', from: 'aplisay.dateTime' }, { from: 'crm.tier' }],
      }),
    ).not.toThrow();
  });

  it('rejects a non-array, bad entries and unknown properties', () => {
    expect(() => validatePromptMetadata({ Handler: plain, promptMetadata: 'nope' })).toThrow(/must be an array/);
    expect(() => validatePromptMetadata({ Handler: plain, promptMetadata: [{ description: 'no from' }] })).toThrow(/from is required/);
    expect(() => validatePromptMetadata({ Handler: plain, promptMetadata: [{ from: 'a b' }] })).toThrow(/not a valid metadata path/);
    expect(() => validatePromptMetadata({ Handler: plain, promptMetadata: [{ from: 'a', description: 5 }] })).toThrow(/description must be a string/);
    expect(() => validatePromptMetadata({ Handler: plain, promptMetadata: [{ from: 'a', value: 'x' }] })).toThrow(/unknown property 'value'/);
  });

  it('caps the number of entries', () => {
    const many = Array.from({ length: 21 }, () => ({ from: 'aplisay.callerId' }));
    expect(() => validatePromptMetadata({ Handler: plain, promptMetadata: many })).toThrow(/at most 20/);
  });

  it('gates toolsCalls paths to dynamic-metadata handlers, like source:"metadata" does', () => {
    const decl = [{ description: 'Last tool said', from: 'toolsCalls.t1.result.name' }];
    expect(() => validatePromptMetadata({ Handler: plain, promptMetadata: decl })).toThrow(/only allowed in LiveKit/);
    expect(() => validatePromptMetadata({ Handler: dynamic, promptMetadata: decl })).not.toThrow();
  });
});
