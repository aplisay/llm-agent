import { askOptions } from '../lib/ask-options.js';

/**
 * Normalise rich model choices to the strings ask_user promises before emitting or storing them. See PR #331.
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
