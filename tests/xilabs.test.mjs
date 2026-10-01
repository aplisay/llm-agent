import { getAccent, mapXiLabsVoices } from '../lib/voices/xilabs.js';

describe('XiLabs accent parsing', () => {
  test('maps a complete accent name without a decorator', () => {
    expect(getAccent('british')).toEqual({ language: 'en-GB', decorator: '' });
  });

  test('keeps the unmatched suffix as the decorator', () => {
    expect(getAccent('brit')).toEqual({ language: 'en-GB', decorator: 'ish' });
  });

  test('treats regular-expression characters as plain input', () => {
    expect(getAccent('[')).toEqual({ language: 'en-US', decorator: '' });
  });
});

describe('XiLabs voice rows', () => {
  test('describes a voice by its name and labels', () => {
    const [row] = mapXiLabsVoices([{
      voice_id: 'CwhRBWXzGAHq8TQ4Fs17',
      name: 'Roger - Laid-Back, Casual, Resonant',
      labels: { descriptive: 'classy', gender: 'male', accent: 'american', age: 'middle_aged' },
    }]);
    expect(row).toEqual({
      name: 'CwhRBWXzGAHq8TQ4Fs17',
      gender: 'male',
      description: 'Roger - Laid-Back, Casual, Resonant - middle aged classy',
      language: 'en-US',
    });
  });

  test('leaves out labels the voice does not have', () => {
    // A cloned voice with no age read "My Clone - undefined ".
    const [row] = mapXiLabsVoices([{
      voice_id: 'clonedvoiceid0000001',
      name: 'My Clone',
      labels: { gender: 'male', accent: 'british' },
    }]);
    expect(row.description).toBe('My Clone');
    expect(row.language).toBe('en-GB');
  });

  test('still reads the older description label', () => {
    const [row] = mapXiLabsVoices([{
      voice_id: 'x', name: 'Rachel', labels: { accent: 'american', age: 'young', description: 'calm' },
    }]);
    expect(row.description).toBe('Rachel - young calm');
  });

  test('keeps a voice with no labels or no accent', () => {
    // getAccent(undefined) threw, which failed the whole catalogue.
    const rows = mapXiLabsVoices([
      { voice_id: 'a', name: 'No Labels' },
      { voice_id: 'b', name: 'No Accent', labels: { age: 'old' } },
    ]);
    expect(rows).toEqual([
      { name: 'a', gender: undefined, description: 'No Labels', language: 'en-US' },
      { name: 'b', gender: undefined, description: 'No Accent - old', language: 'en-US' },
    ]);
  });
});
