/** GET https://api.cartesia.ai/voices pages in the shape the live API returns (2026-09-30). */
const voice = (over) => ({
  description: '', created_at: '2026-01-01T00:00:00Z', is_owner: false, status: 'active', is_public: true,
  access: { type: 'public', visibility: 'all' }, mode: 'similarity', is_pro: false, tagline: '', accents: [], ...over,
});
const native = (locale) => [{ accent: 'x', locale, is_native: true }, { accent: 'y', locale: 'hi-IN', is_native: false }];

export const CARTESIA_PAGES = [
  {
    has_more: true,
    next_page: 'c-katie',
    data: [
      voice({ id: 'c-skylar', name: 'Skylar - Friendly Guide', description: 'Approachable American female.', language: 'en', country: 'US', gender: 'feminine', accents: native('en-US') }),
      voice({ id: 'c-george', name: 'George', description: 'Calm British man.', language: 'en', country: 'GB', gender: 'masculine', accents: native('en-GB') }),
      voice({ id: 'c-katie', name: 'Katie', language: 'en', country: 'AU', gender: 'feminine', accents: native('en-AU') }),
    ],
  },
  {
    has_more: false,
    next_page: null,
    data: [
      voice({ id: 'c-luc', name: 'Luc', description: 'Warm\nQuebec voice.', language: 'fr', country: 'CA', gender: 'masculine', accents: native('fr-CA') }),
      // No native accent: language + country, else the language's likely region.
      voice({ id: 'c-varun', name: 'Varun', language: 'hi', country: null, gender: 'masculine' }),
      voice({ id: 'c-gerard', name: 'Gerard', language: 'es', country: 'MX', gender: 'masculine' }),
      voice({ id: 'c-sam', name: 'Sam', language: 'de', gender: 'gender_neutral', accents: native('de-DE') }),
      // sonic-3 cannot speak Urdu.
      voice({ id: 'c-zara', name: 'Zara', language: 'ur', country: 'IN', gender: 'feminine', accents: native('ur-IN') }),
      voice({ id: 'c-clone', name: 'My clone', language: 'en', is_public: false, is_owner: true }),
      voice({ id: 'c-gone', name: 'Retired', language: 'en', status: 'deprecated' }),
      voice({ id: 'c-nolang', name: 'Broken' }),
    ],
  },
];
