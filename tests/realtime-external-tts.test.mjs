import PipecatModel, {
  pipecatModelIdFlags,
  pipecatModelSupportsExternalTts,
} from '../lib/models/pipecat.js';
import {
  getTtsVendorsForAgentValidation,
  getVoiceNamesForAgentValidation,
  isExternalTtsForModel,
  modelSupportsExternalTts,
  nativeTtsVendorForModel,
} from '../lib/model-voices.js';

/**
 * External TTS on a realtime model (text-output mode), server side. The rule
 * (docs/realtime-external-tts.md): on a realtime row, `options.tts.vendor` set to
 * a vendor other than the model's own provider switches the model to text output
 * and that TTS speaks. Only rows flagged `externalTts` can honour it; the API
 * validates such a vendor and its voice against the discrete TTS catalogue rather
 * than the model's own voices. These tests pin the flag, the rule and the
 * catalogues; the pipecat worker's side is tests/test_realtime_external_tts.py.
 */

const ULTRAVOX = 'pipecat:ultravox/ultravox-v0.7';

describe('external TTS on realtime models', () => {
  describe('roster flag', () => {
    test('Ultravox realtime rows carry externalTts; other rows do not', () => {
      expect(pipecatModelSupportsExternalTts('ultravox/ultravox-v0.7')).toBe(true);
      expect(pipecatModelSupportsExternalTts('ultravox/ultravox-v0.6')).toBe(true);
      expect(pipecatModelSupportsExternalTts('ultravox/ultravox-v0.6-gemma3-27b')).toBe(true);
      expect(pipecatModelSupportsExternalTts('openai/gpt-realtime')).toBe(false);
      expect(pipecatModelSupportsExternalTts('google/gemini-2.0-flash-exp')).toBe(false);
      expect(pipecatModelSupportsExternalTts('openai/gpt-4o-mini')).toBe(false);
      expect(pipecatModelIdFlags['ultravox/ultravox-v0.7']).toMatchObject({
        voiceStack: 'realtime',
        externalTts: true,
      });
      expect(pipecatModelIdFlags['openai/gpt-realtime'].externalTts).toBeUndefined();
    });

    test('the allModels rows carry the flag the handler exposes as hasExternalTts', () => {
      const flagged = PipecatModel.allModels
        .filter(([, , flags]) => flags.externalTts === true)
        .map(([id]) => id);
      expect(flagged.sort()).toEqual([
        'ultravox/ultravox-v0.6',
        'ultravox/ultravox-v0.6-gemma3-27b',
        'ultravox/ultravox-v0.7',
      ]);
    });

    test('modelSupportsExternalTts resolves by handler and row', () => {
      expect(modelSupportsExternalTts(ULTRAVOX)).toBe(true);
      expect(modelSupportsExternalTts('pipecat:openai/gpt-realtime')).toBe(false);
      // The LiveKit rows are not wired yet.
      expect(modelSupportsExternalTts('livekit:ultravox/ultravox-v0.7')).toBe(false);
      // The native handler has no worker in the media path to host a TTS.
      expect(modelSupportsExternalTts('ultravox:ultravox/ultravox-v0.7')).toBe(false);
      expect(modelSupportsExternalTts('nonsense')).toBe(false);
    });
  });

  describe('the rule', () => {
    test('the native vendor is the provider segment of the model id', () => {
      expect(nativeTtsVendorForModel(ULTRAVOX)).toBe('ultravox');
      expect(nativeTtsVendorForModel('livekit:openai/gpt-realtime')).toBe('openai');
      expect(nativeTtsVendorForModel('pipecat:google/gemini-2.0-flash-exp')).toBe('google');
      expect(nativeTtsVendorForModel('pipecat:')).toBe('');
    });

    test('unset, blank or native vendors keep the model\'s own voice', () => {
      expect(isExternalTtsForModel({ modelName: ULTRAVOX, vendor: undefined })).toBe(false);
      expect(isExternalTtsForModel({ modelName: ULTRAVOX, vendor: '   ' })).toBe(false);
      expect(isExternalTtsForModel({ modelName: ULTRAVOX, vendor: 'ultravox' })).toBe(false);
      expect(isExternalTtsForModel({ modelName: ULTRAVOX, vendor: 'Ultravox' })).toBe(false);
      expect(isExternalTtsForModel({ modelName: 'pipecat:openai/gpt-realtime', vendor: 'openai' })).toBe(false);
      // google is a TTS vendor too, but on a Gemini row it is the model's own voice.
      expect(isExternalTtsForModel({ modelName: 'pipecat:google/gemini-2.0-flash-exp', vendor: 'google' })).toBe(false);
    });

    test('any other vendor is external, with scoping and case ignored', () => {
      expect(isExternalTtsForModel({ modelName: ULTRAVOX, vendor: 'elevenlabs' })).toBe(true);
      expect(isExternalTtsForModel({ modelName: ULTRAVOX, vendor: 'ElevenLabs/eleven_flash_v2_5' })).toBe(true);
      expect(isExternalTtsForModel({ modelName: ULTRAVOX, vendor: 'google' })).toBe(true);
      // The rule is stack-wide; whether the row can honour it is the flag's job.
      expect(isExternalTtsForModel({ modelName: 'livekit:ultravox/ultravox-v0.7', vendor: 'cartesia' })).toBe(true);
      expect(isExternalTtsForModel({ modelName: 'pipecat:openai/gpt-realtime', vendor: 'cartesia' })).toBe(true);
    });

    test('pipeline rows and other handlers are never "external"', () => {
      expect(isExternalTtsForModel({ modelName: 'pipecat:openai/gpt-4o-mini', vendor: 'elevenlabs' })).toBe(false);
      expect(isExternalTtsForModel({ modelName: 'livekit:openai/gpt-4o-mini', vendor: 'elevenlabs' })).toBe(false);
      expect(isExternalTtsForModel({ modelName: 'jambonz:openai/gpt-4o', vendor: 'elevenlabs' })).toBe(false);
      expect(isExternalTtsForModel({ modelName: 'ultravox:ultravox/ultravox-v0.7', vendor: 'elevenlabs' })).toBe(false);
    });
  });

  describe('validation catalogues', () => {
    // The platform's discrete TTS catalogue (lib/voices) and the model's own voices.
    const voicesInstance = {
      listVoices: async () => ({
        elevenlabs: { 'en-GB': [{ name: 'Rachel' }] },
        deepgram: { 'en-US': [{ name: 'aura-asteria-en' }] },
        google: { 'en-GB': [{ name: 'en-GB-Wavenet-A' }] },
      }),
    };
    const Handler = { voices: Promise.resolve({ ultravox: { any: [{ name: 'Mark' }] } }) };

    test('an external vendor is validated against the worker TTS catalogue', async () => {
      const vendors = await getTtsVendorsForAgentValidation({
        modelName: ULTRAVOX, Handler, voicesInstance, discreteTts: true,
      });
      expect(vendors.has('elevenlabs')).toBe(true);
      expect(vendors.has('deepgram')).toBe(true);
      // Absent from the catalogue but the worker can build it.
      expect(vendors.has('cartesia')).toBe(true);
      // The pipecat worker cannot build a Google TTS, so it must not be offered.
      expect(vendors.has('google')).toBe(false);
      expect(vendors.has('ultravox')).toBe(false);

      const names = await getVoiceNamesForAgentValidation({
        modelName: ULTRAVOX, Handler, voicesInstance, discreteTts: true,
      });
      expect(names.has('Rachel')).toBe(true);
      expect(names.has('aura-asteria-en')).toBe(true);
      expect(names.has('Mark')).toBe(false);
    });

    test('the model\'s own voices remain the catalogue when the vendor is native', async () => {
      const vendors = await getTtsVendorsForAgentValidation({ modelName: ULTRAVOX, Handler, voicesInstance });
      expect([...vendors]).toEqual(['ultravox']);
      const names = await getVoiceNamesForAgentValidation({ modelName: ULTRAVOX, Handler, voicesInstance });
      expect(names.has('Mark')).toBe(true);
      expect(names.has('Rachel')).toBe(false);
    });
  });
});
