/** A GET https://api.neuphonic.com/voices body in the shape the live API returns (2026-09-22). */
const voice = (over) => ({
  id: over.voice_id, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  default: false, type: 'Standard', ...over,
});

export const NEUPHONIC_FIXTURE = {
  data: {
    voices: [
      voice({ voice_id: 'v-emily', name: 'Emily', lang_code: 'en', tags: ['Female', 'American', 'Conversational'] }),
      voice({ voice_id: 'v-liz', name: 'Liz', lang_code: 'en', tags: ['Female', 'British'] }),
      voice({ voice_id: 'v-callum', name: 'Callum', lang_code: 'en', tags: ['Male', 'Scottish Accent'] }),
      voice({ voice_id: 'v-liam', name: 'Liam', lang_code: 'en', tags: ['Male', 'Irish Accent'] }),
      voice({ voice_id: 'v-jack', name: 'Jack', lang_code: 'en', tags: ['Male', 'Australian Accent'] }),
      voice({ voice_id: 'v-ishita', name: 'Ishita', lang_code: 'en', tags: ['Female', 'Indian Accent'] }),
      voice({ voice_id: 'v-rebecca', name: 'Rebecca', lang_code: 'en', tags: ['Female', 'Casual'] }),
      voice({ voice_id: 'v-alejandra', name: 'Alejandra', lang_code: 'es', tags: ['Venezuelan', 'Female'] }),
      voice({ voice_id: 'v-mateo', name: 'Mateo', lang_code: 'es', tags: [] }),
      voice({ voice_id: 'v-cadu', name: 'Cadu', lang_code: 'pt', tags: ['Male', 'Brazilian'] }),
      voice({ voice_id: 'v-manoel', name: 'Manoel', lang_code: 'pt', tags: ['Male', 'Portuguese'] }),
      voice({ voice_id: 'v-emilia', name: 'Emilia', lang_code: 'de', tags: ['Female', 'German'] }),
      voice({ voice_id: 'v-ruoxi', name: '若曦 (Ruòxī)', lang_code: 'zh', tags: ['Chinese', 'Woman'] }),
      voice({ voice_id: 'v-seojun', name: 'Seo-jun\t(서준)', lang_code: 'ko', tags: [] }),
      voice({ voice_id: 'v-clone', name: 'Someone', lang_code: 'en', tags: ['Male'], type: 'Cloned' }),
      { voice_id: 'v-nolang', name: 'Broken', tags: [] },
    ],
  },
};
