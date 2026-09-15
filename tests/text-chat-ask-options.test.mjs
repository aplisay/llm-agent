import { askOptions } from '../lib/ask-options.js';

/**
 * `ask_user` declares `options: { items: { type: 'string' } }`, but the frame
 * builder used to forward the model's raw tool input on nothing more than an
 * Array.isArray check. Models routinely answer a choice tool with rich options
 * — `[{ label, description }, …]` — and clients got objects where the schema
 * promised strings: polite.ai's composer handed one to React and the whole
 * builder page died (2026-09-15), and this session's own transcript recorded
 * the ask as "(options: [object Object])", which is what the model reads back
 * on resume.
 */

describe('askOptions', () => {
  test('passes strings through, dropping empties', () => {
    expect(askOptions(['Keep both', '', 'Replace'])).toEqual(['Keep both', 'Replace']);
  });

  test('keeps a rich choice as its label rather than dropping it', () => {
    expect(askOptions([
      { label: 'Keep both', description: 'Leave the original in place' },
      { label: 'Replace', description: 'Retire the original' },
    ])).toEqual(['Keep both', 'Replace']);
  });

  test('accepts the other names a model reaches for', () => {
    expect(askOptions([{ value: 'yes' }, { name: 'no' }, { text: 'maybe' }, { title: 'later' }]))
      .toEqual(['yes', 'no', 'maybe', 'later']);
  });

  test('prefers label over the fallbacks', () => {
    expect(askOptions([{ label: 'Keep', value: 'keep-both', description: '…' }])).toEqual(['Keep']);
  });

  test('drops anything with no usable text, and never throws', () => {
    expect(askOptions([{ description: 'no label' }, null, 42, [], {}])).toEqual([]);
    expect(askOptions(undefined)).toEqual([]);
    expect(askOptions('Keep both')).toEqual([]);
  });

  test('the recorded transcript line is readable, not [object Object]', () => {
    const options = askOptions([{ label: 'Keep both', description: '…' }, { label: 'Replace' }]);
    expect(`Which one? (options: ${options.join(' / ')})`).toBe('Which one? (options: Keep both / Replace)');
  });
});
