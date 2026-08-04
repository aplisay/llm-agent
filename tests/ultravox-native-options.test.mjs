import Ultravox from '../lib/models/ultravox.js';

/**
 * Unit tests for the native Ultravox driver's option mapping (lib/models/ultravox.js):
 * portable `options.greeting` → firstSpeakerSettings, portable `options.inactivity`
 * → inactivityMessages, and the vendorSpecific.ultravox pass-through whitelist.
 * These are the options applied to the Ultravox `POST /calls` body for
 * `ultravox:`-prefixed agents on every medium (WebRTC, WebSocket, jambonz telephony).
 */

const mockLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  child: () => mockLogger,
};

const makeModel = (options = {}) =>
  new Ultravox({
    logger: mockLogger,
    user: 'test-user',
    prompt: 'You are a test agent.',
    options,
    modelName: 'ultravox:ultravox/ultravox-v0.6',
  });

describe('Ultravox native driver option mapping', () => {
  describe('baseline', () => {
    test('no options produces defaults and no greeting/inactivity settings', () => {
      const data = makeModel().modelData;
      expect(data.model).toBe('ultravox-v0.6');
      expect(data.maxDuration).toBe('305s');
      expect(data.timeExceededMessage).toMatch(/great chatting/);
      expect(data.firstSpeakerSettings).toBeUndefined();
      expect(data.inactivityMessages).toBeUndefined();
      expect(data.vadSettings).toBeUndefined();
      expect(data.experimentalSettings).toBeUndefined();
    });

    test('custom maxDuration and timeExceededMessage pass through', () => {
      const data = makeModel({
        maxDuration: '120s',
        timeExceededMessage: 'Time is up, goodbye!',
      }).modelData;
      expect(data.maxDuration).toBe('120s');
      expect(data.timeExceededMessage).toBe('Time is up, goodbye!');
    });
  });

  describe('options.greeting → firstSpeakerSettings', () => {
    test('greeting.text maps to an uninterruptible agent text', () => {
      const data = makeModel({ greeting: { text: 'Hello, how can I help?' } }).modelData;
      expect(data.firstSpeakerSettings).toEqual({
        agent: { uninterruptible: true, text: 'Hello, how can I help?' },
      });
    });

    test('greeting.instructions maps to an uninterruptible agent prompt', () => {
      const data = makeModel({ greeting: { instructions: 'Greet the caller briefly.' } }).modelData;
      expect(data.firstSpeakerSettings).toEqual({
        agent: { uninterruptible: true, prompt: 'Greet the caller briefly.' },
      });
    });

    test('whitespace-only greeting is ignored', () => {
      const data = makeModel({ greeting: { text: '   ' } }).modelData;
      expect(data.firstSpeakerSettings).toBeUndefined();
    });

    test('invalid greeting with both text and instructions is not mapped', () => {
      const data = makeModel({
        greeting: { text: 'Hello', instructions: 'Say hello' },
      }).modelData;
      expect(data.firstSpeakerSettings).toBeUndefined();
    });

    test('explicit firstSpeaker user suppresses the greeting mapping', () => {
      const data = makeModel({
        firstSpeaker: 'user',
        greeting: { text: 'Hello, how can I help?' },
      }).modelData;
      expect(data.firstSpeakerSettings).toBeUndefined();
    });

    test('caller-supplied vendorSpecific firstSpeakerSettings win over greeting', () => {
      const native = { agent: { text: 'Native greeting' } };
      const data = makeModel({
        greeting: { text: 'Portable greeting' },
        vendorSpecific: { ultravox: { firstSpeakerSettings: native } },
      }).modelData;
      expect(data.firstSpeakerSettings).toBe(native);
    });
  });

  describe('options.inactivity → inactivityMessages', () => {
    test('duration-string timeout maps to three repeated nudges with no hang-up', () => {
      const data = makeModel({
        inactivity: { timeout: '30s', message: 'Are you still there?' },
      }).modelData;
      expect(data.inactivityMessages).toEqual([
        { duration: '30s', message: 'Are you still there?' },
        { duration: '30s', message: 'Are you still there?' },
        { duration: '30s', message: 'Are you still there?' },
      ]);
      expect(data.inactivityMessages.every((m) => m.endBehavior === undefined)).toBe(true);
    });

    test('hangup:true sets END_BEHAVIOR_HANG_UP_SOFT on the last nudge only', () => {
      const data = makeModel({
        inactivity: { timeout: '30s', message: 'Are you still there?', hangup: true },
      }).modelData;
      expect(data.inactivityMessages).toHaveLength(3);
      // Earlier nudges must not end the call; SOFT (not STRICT) on the last so the
      // final prompt is still delivered rather than cut mid-word.
      expect(data.inactivityMessages.slice(0, -1).every((m) => m.endBehavior === undefined)).toBe(true);
      expect(data.inactivityMessages.at(-1)).toEqual({
        duration: '30s',
        message: 'Are you still there?',
        endBehavior: 'END_BEHAVIOR_HANG_UP_SOFT',
      });
    });

    test('hangup must be strictly true to arm', () => {
      for (const hangup of [false, 'yes', 1, undefined]) {
        const data = makeModel({
          inactivity: { timeout: '30s', message: 'Are you still there?', hangup },
        }).modelData;
        expect(data.inactivityMessages.every((m) => m.endBehavior === undefined)).toBe(true);
      }
    });

    test('numeric timeout is converted to a duration string', () => {
      const data = makeModel({
        inactivity: { timeout: 20, message: 'Hello?' },
      }).modelData;
      expect(data.inactivityMessages[0]).toEqual({ duration: '20s', message: 'Hello?' });
    });

    test('malformed inactivity blocks are ignored', () => {
      expect(makeModel({ inactivity: { timeout: '30s', message: '  ' } }).modelData.inactivityMessages).toBeUndefined();
      expect(makeModel({ inactivity: { timeout: 0, message: 'Hello?' } }).modelData.inactivityMessages).toBeUndefined();
      expect(makeModel({ inactivity: { message: 'Hello?' } }).modelData.inactivityMessages).toBeUndefined();
      expect(makeModel({ inactivity: { timeout: 'soon', message: 'Hello?' } }).modelData.inactivityMessages).toBeUndefined();
    });

    test('caller-supplied vendorSpecific inactivityMessages win over portable inactivity', () => {
      const native = [{ duration: '45s', message: 'Native nudge', endBehavior: 'END_BEHAVIOR_HANG_UP_SOFT' }];
      const data = makeModel({
        inactivity: { timeout: '30s', message: 'Portable nudge' },
        vendorSpecific: { ultravox: { inactivityMessages: native } },
      }).modelData;
      expect(data.inactivityMessages).toBe(native);
    });
  });

  describe('vendorSpecific.ultravox pass-through', () => {
    test('vadSettings and experimentalSettings are forwarded', () => {
      const vadSettings = { turnEndpointDelay: '0.5s' };
      const experimentalSettings = { transcriptionProvider: 'deepgram-nova-3' };
      const data = makeModel({
        vendorSpecific: { ultravox: { vadSettings, experimentalSettings } },
      }).modelData;
      expect(data.vadSettings).toBe(vadSettings);
      expect(data.experimentalSettings).toBe(experimentalSettings);
    });

    test('unlisted vendorSpecific keys are not forwarded', () => {
      const data = makeModel({
        vendorSpecific: { ultravox: { recordingEnabled: false, model: 'evil-override' } },
      }).modelData;
      expect(data.recordingEnabled).toBeUndefined();
      expect(data.model).toBe('ultravox-v0.6');
    });
  });

  describe('options.tts.language → languageHint', () => {
    test('tts.language is sent as languageHint, keeping the region subtag', () => {
      const data = makeModel({ tts: { voice: 'Mark', language: 'en-GB' } }).modelData;
      expect(data.languageHint).toBe('en-GB');
    });

    test('falls back to stt.language when tts.language is unset', () => {
      const data = makeModel({ stt: { language: 'fr-FR' } }).modelData;
      expect(data.languageHint).toBe('fr-FR');
    });

    test('tts.language wins over stt.language', () => {
      const data = makeModel({
        tts: { language: 'de-DE' },
        stt: { language: 'fr-FR' },
      }).modelData;
      expect(data.languageHint).toBe('de-DE');
    });

    test('no language options leaves languageHint unset (Ultravox auto-detects)', () => {
      expect(makeModel().modelData.languageHint).toBeUndefined();
      expect(makeModel({ tts: { voice: 'Mark' } }).modelData.languageHint).toBeUndefined();
    });

    test('non-specific language sentinels do not produce a languageHint', () => {
      for (const language of ['any', 'multi', 'auto', '*', 'ALL', '  ']) {
        expect(makeModel({ tts: { language } }).modelData.languageHint).toBeUndefined();
      }
    });

    test('caller-supplied vendorSpecific languageHint wins over the portable option', () => {
      const data = makeModel({
        tts: { language: 'en-GB' },
        vendorSpecific: { ultravox: { languageHint: 'cy-GB' } },
      }).modelData;
      expect(data.languageHint).toBe('cy-GB');
    });
  });
});
