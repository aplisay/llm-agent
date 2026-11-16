import {
  setupRealDatabase, teardownRealDatabase, databaseStarted,
  UsageRecord, Organisation, User, Agent, Instance, Call, RateCard, Op,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';
import { resolveRowCost, MICROS_PER_PENNY, sweepUncostedRows } from '../lib/rates.js';
import { computeDestinationCost } from '../lib/tariffs.js';
import { buildRateComponents, isMinuteBilledModel } from '../lib/rate-components.js';
import { recordSubagentUsage } from '../lib/usage.js';

// Pins the worked examples and rules in docs/billing-calls-from-usage.md to the
// real engine. When one fails, change the doc and the expected value together.

const tok = (provider, detail, prices) => Object.entries(prices).map(([unit, priceMicros]) => (
  { dim: 'model', match: { technology: 'llm', provider, detail, unit }, unit: 'token', priceMicros }
));
const both = (technology, provider, perMinute, perChar) => [
  { dim: technology.startsWith('stt') ? 'stt' : 'tts', match: { technology, provider, unit: 'milliseconds' }, unit: 'minute', priceMicros: perMinute },
  { dim: technology.startsWith('stt') ? 'stt' : 'tts', match: { technology, provider, unit: 'characters' }, unit: 'character', priceMicros: perChar },
];

// "The example card" in the doc, in the same order.
const BRIDGED_LINE = { dim: 'audio-path', match: { technology: 'voice', detail: 'telephony:bridged-call', media: 'telephony' }, unit: 'minute', priceMicros: 20_000 };
const LIVEKIT_TELEPHONY = { dim: 'audio-path', match: { technology: 'voice', provider: 'livekit', media: 'telephony' }, unit: 'minute', priceMicros: 60_000 };
const OTHER_LINES = [
  { dim: 'audio-path', match: { technology: 'voice', provider: 'livekit', media: 'webrtc' }, unit: 'minute', priceMicros: 40_000 },
  { dim: 'audio-path', match: { technology: 'voice', provider: 'pipecat', media: 'telephony' }, unit: 'minute', priceMicros: 60_000 },
  { dim: 'audio-path', match: { technology: 'voice', provider: 'pipecat', media: 'webrtc' }, unit: 'minute', priceMicros: 40_000 },
  { dim: 'model', match: { technology: 'voice', detail: 'livekit:ultravox/ultravox-v0.6' }, unit: 'minute', priceMicros: 90_000 },
  { dim: 'model', match: { technology: 'voice', detail: 'pipecat:ultravox/ultravox-v0.6' }, unit: 'minute', priceMicros: 90_000 },
  { dim: 'model', match: { technology: 'voice', detail: 'pipecat:openai/gpt-live-1' }, unit: 'minute', priceMicros: 100_000 },
  ...tok('openai', 'openai/gpt-5.6-luna', { input_tokens: 0.22, output_tokens: 1.4, cache_read_tokens: 0.022, cache_write_tokens: 0.28 }),
  ...tok('anthropic', 'claude-haiku-4-5', { input_tokens: 1.1, output_tokens: 5.5 }),
  ...tok('openai', 'openai/gpt-4o-mini', { input_tokens: 0.17, output_tokens: 0.66 }),
  { dim: 'tts', match: { technology: 'tts', provider: 'ultravox', unit: 'milliseconds' }, unit: 'minute', priceMicros: 0 },
  ...both('tts', 'elevenlabs', 0, 110),
  ...both('stt', 'assemblyai', 8_300, 0),
  ...both('stt', 'deepgram', 11_000, 0),
  ...both('stt-aux', 'deepgram', 11_000, 0),
  ...both('stt-output', 'deepgram', 11_000, 0),
];
const CARD = { detail: { lines: [BRIDGED_LINE, LIVEKIT_TELEPHONY, ...OTHER_LINES] } };

const voice = (provider, detail, media, quantity) => ({ technology: 'voice', provider, detail, unit: 'milliseconds', media, quantity });
const row = (technology, provider, detail, unit, quantity) => ({ technology, provider, detail, unit, quantity });
const cost = (r, card = CARD) => resolveRowCost(r, card).costMicros;
const total = (rows) => rows.reduce((sum, r) => sum + cost(r), 0);

const LK_ULTRAVOX = 'livekit:ultravox/ultravox-v0.6';
const PC_ULTRAVOX = 'pipecat:ultravox/ultravox-v0.6';
const BRIDGED = 'telephony:bridged-call';

describe('billing guide: money and rules', () => {
  it('10,000 micros is 1p', () => {
    expect(MICROS_PER_PENNY).toBe(10_000);
  });

  it('a character TTS line without match.unit also prices the milliseconds row', () => {
    const card = { detail: { lines: [{ dim: 'tts', match: { technology: 'tts', provider: 'elevenlabs' }, unit: 'character', priceMicros: 110 }] } };
    expect(cost(row('tts', 'elevenlabs', 'elevenlabs/eleven_turbo_v2_5', 'milliseconds', 30_266), card)).toBe(30_266 * 110);
    expect(cost(row('tts', 'elevenlabs', 'elevenlabs/eleven_turbo_v2_5', 'milliseconds', 30_266))).toBe(0);
  });

  it('token lines match the exact detail form', () => {
    expect(cost(row('llm', 'anthropic', 'claude-haiku-4-5', 'input_tokens', 3_000))).toBe(3_300);
    expect(resolveRowCost(row('llm', 'anthropic', 'anthropic/claude-haiku-4-5', 'input_tokens', 3_000), CARD).status).toBe('no_line');
  });

  it('the catalogue tts and stt templates carry no unit; minute-billed models price the voice detail', () => {
    const comps = buildRateComponents({ models: [{ name: 'pipecat:openai/gpt-live-1' }] });
    for (const c of comps.filter((x) => x.dim === 'tts' || x.dim === 'stt')) expect(c.match.unit).toBeUndefined();
    expect(comps.find((c) => c.key === 'model:pipecat:openai/gpt-live-1').match)
      .toEqual({ technology: 'voice', detail: 'pipecat:openai/gpt-live-1' });
    for (const m of [LK_ULTRAVOX, 'pipecat:openai/gpt-live-1', 'pipecat:xai/grok-voice-think-fast-2.0', 'livekit:elevenlabs/gpt-5.4-mini']) {
      expect(isMinuteBilledModel(m)).toBe(true);
    }
    expect(isMinuteBilledModel('livekit:openai/gpt-4o-mini')).toBe(false);
  });

  it('destination = callStart + max(minimum, connect + perMinute x rounded minutes)', () => {
    const tariff = { callStartMicros: 1_000, roundingSeconds: 6, timezone: 'Europe/London', schedule: {} };
    const prefix = { connectMicros: 500, peakPerMinuteMicros: 9_000, offPeakPerMinuteMicros: 2_000, minimumMicros: 3_000 };
    // 61 s rounds to 66 s: 500 + 2,000 x 1.1 = 2,700, below the 3,000 minimum.
    expect(computeDestinationCost(tariff, prefix, { billedAt: new Date(), durationMs: 61_000 }).costMicros).toBe(4_000);
    expect(computeDestinationCost(tariff, prefix, { billedAt: new Date(), durationMs: 120_000 }).costMicros).toBe(5_500);
  });
});

describe('billing guide: worked examples', () => {
  it('1. Ultravox on LiveKit, phone, 20.775 s', () => {
    const r = voice('livekit', LK_ULTRAVOX, 'telephony', 20_775);
    expect(resolveRowCost(r, CARD).breakdown.map((b) => [b.dim, b.quantity, b.costMicros]))
      .toEqual([['audio-path', 0.4, 24_000], ['model', 0.4, 36_000]]);
    expect(cost(r)).toBe(60_000);
  });

  it('1. Ultravox on Pipecat, browser, 54.874 s, own speech included', () => {
    const speech = row('tts', 'ultravox', 'Louisamay', 'milliseconds', 31_020);
    expect(cost(voice('pipecat', PC_ULTRAVOX, 'webrtc', 54_874))).toBe(130_000);
    expect(resolveRowCost(speech, CARD)).toMatchObject({ status: 'matched', costMicros: 0 });
  });

  it('2. blind bridged transfer on LiveKit, and the card-order tie', () => {
    const bridged = voice('livekit', BRIDGED, 'telephony', 12_855);
    expect(total([voice('livekit', LK_ULTRAVOX, 'telephony', 20_775), bridged])).toBe(66_000);
    const swapped = { detail: { lines: [LIVEKIT_TELEPHONY, BRIDGED_LINE, ...OTHER_LINES] } };
    expect(cost(bridged, swapped)).toBe(18_000);
  });

  it('2. blind transfer by REFER: the agent leg only, 30 s', () => {
    expect(cost(voice('livekit', LK_ULTRAVOX, 'telephony', 30_000))).toBe(75_000);
  });

  it('2. consultative transfer then bridged on LiveKit', () => {
    const legs = [
      voice('livekit', LK_ULTRAVOX, 'telephony', 47_682),
      voice('livekit', LK_ULTRAVOX, 'telephony', 25_757),
      voice('livekit', BRIDGED, 'telephony', 12_469),
    ];
    expect(legs.map((l) => cost(l))).toEqual([120_000, 75_000, 6_000]);
    expect(total(legs)).toBe(201_000);
  });

  it('2. Pipecat browser caller, bridged (agent leg ends at the bridge)', () => {
    const legs = [voice('pipecat', PC_ULTRAVOX, 'webrtc', 11_643), voice('pipecat', BRIDGED, 'telephony', 53_487)];
    expect(legs.map((l) => cost(l))).toEqual([26_000, 18_000]);
    expect(total(legs)).toBe(44_000);
  });

  it('3. side STT engines, and an stt line does not price stt-aux', () => {
    const rows = [
      voice('livekit', LK_ULTRAVOX, 'telephony', 20_775),
      row('stt-aux', 'deepgram', 'deepgram/nova-3', 'milliseconds', 6_600),
      row('stt-aux', 'deepgram', 'deepgram/nova-3', 'characters', 70),
      row('stt-output', 'deepgram', 'deepgram/nova-3', 'milliseconds', 3_645),
      row('stt-output', 'deepgram', 'deepgram/nova-3', 'characters', 63),
    ];
    expect(rows.map((r) => cost(r))).toEqual([60_000, 2_200, 0, 1_100, 0]);
    expect(total(rows)).toBe(63_300);
    const sttOnly = { detail: { lines: both('stt', 'deepgram', 11_000, 0) } };
    expect(resolveRowCost(rows[1], sttOnly).status).toBe('no_line');
  });

  it('4. GPT-Live with OpenAI-hosted delegation', () => {
    const luna = (unit, q) => row('llm', 'openai', 'openai/gpt-5.6-luna', unit, q);
    const rows = [
      voice('pipecat', 'pipecat:openai/gpt-live-1', 'webrtc', 32_452),
      luna('cache_read_tokens', 2_508), luna('cache_write_tokens', 1_673),
      luna('input_tokens', 135), luna('output_tokens', 169),
    ];
    expect(rows.map((r) => cost(r))).toEqual([84_000, 55, 468, 30, 237]);
    expect(total(rows)).toBe(84_790);
  });

  it('4. GPT-Live with client delegation to claude-haiku-4-5', () => {
    expect(cost(row('llm', 'anthropic', 'claude-haiku-4-5', 'input_tokens', 3_000))).toBe(3_300);
    expect(cost(row('llm', 'anthropic', 'claude-haiku-4-5', 'output_tokens', 250))).toBe(1_375);
  });

  it('5. pipeline agent on LiveKit: the voice row takes the audio path only', () => {
    const rows = [
      voice('livekit', 'livekit:openai/gpt-4o-mini', 'webrtc', 60_790),
      row('llm', 'openai', 'openai/gpt-4o-mini', 'input_tokens', 1_547),
      row('llm', 'openai', 'openai/gpt-4o-mini', 'output_tokens', 130),
      row('stt', 'assemblyai', 'assemblyai/universal-streaming', 'milliseconds', 51_200),
      row('stt', 'assemblyai', 'assemblyai/universal-streaming', 'characters', 158),
      row('tts', 'elevenlabs', 'elevenlabs/eleven_turbo_v2_5', 'characters', 529),
      row('tts', 'elevenlabs', 'elevenlabs/eleven_turbo_v2_5', 'milliseconds', 30_266),
    ];
    expect(resolveRowCost(rows[0], CARD).breakdown.map((b) => b.dim)).toEqual(['audio-path']);
    expect(rows.map((r) => cost(r))).toEqual([44_000, 263, 86, 7_470, 0, 58_190, 0]);
    expect(total(rows)).toBe(110_009);
  });
});

describe('billing guide: subagent tokens on a call (DB-backed)', () => {
  const name = `guide-${randomUUID()}`;
  let orgId, userId, agentId, delegateId, instanceId;

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    [orgId, userId, agentId, delegateId, instanceId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await Organisation.create({ id: orgId, name: 'Guide Org', rateHistory: [{ name, startDate: '2026-01-01T00:00:00Z' }] });
    await User.create({
      id: userId, name: 'Guide User', email: `guide-${userId}@example.com`,
      emailVerified: true, phone: '', phoneVerified: false, picture: '', role: 'owner', organisationId: orgId,
    });
    for (const [id, modelName] of [[agentId, 'pipecat:openai/gpt-live-1'], [delegateId, 'text:anthropic/claude-haiku-4-5']]) {
      await Agent.create({ id, name: id, modelName, userId, organisationId: orgId }, { validate: false });
    }
    await Instance.create({ id: instanceId, agentId, type: 'pipecat', userId, organisationId: orgId });
    await RateCard.create({ name, startDate: new Date('2026-01-01Z'), detail: CARD.detail });
  }, 30000);

  afterAll(async () => {
    await UsageRecord.destroy({ where: { organisationId: orgId } });
    await RateCard.destroy({ where: { name: { [Op.eq]: name } } });
    await Organisation.destroy({ where: { id: orgId } });
    await teardownRealDatabase();
  }, 30000);

  const callWithDelegation = async () => {
    const call = await Call.create({
      instanceId, agentId, organisationId: orgId, userId, callerId: 'WebRTC', calledId: 'WebRTC',
      platform: 'pipecat', modelName: 'pipecat:openai/gpt-live-1',
    });
    const startedAt = new Date(Date.now() - 60_000);
    call.startedAt = startedAt;
    await recordSubagentUsage({
      sessionId: call.id, callId: call.id, organisationId: orgId,
      usage: [{ agentId: delegateId, provider: 'anthropic', model: 'claude-haiku-4-5', inputTokens: 3_000, outputTokens: 250 }],
    });
    await call.end(undefined, { endedAt: new Date(startedAt.valueOf() + 32_452) });
    return { call, startedAt };
  };
  const subRows = (callId) => UsageRecord.findAll({ where: { callId, technology: 'llm' }, order: [['unit', 'ASC']] });

  it('are priced on the card in force at the call start', async () => {
    const { call, startedAt } = await callWithDelegation();
    const voiceRow = await UsageRecord.findOne({ where: { callId: call.id, technology: 'voice' } });
    expect(Number(voiceRow.costMicros)).toBe(84_000);
    for (const r of await subRows(call.id)) {
      expect(r).toMatchObject({ sessionId: call.id, agentId: delegateId, detail: 'claude-haiku-4-5' });
    }

    // Current release: only the sweep finalises these rows, once they have been
    // untouched for 24 hours. Harmless once they are priced at call end.
    await UsageRecord.sequelize.query(
      "UPDATE usage_records SET updated_at = now() - interval '25 hours' WHERE call_id = :id AND technology = 'llm'",
      { replacements: { id: call.id } },
    );
    await sweepUncostedRows();
    const priced = await subRows(call.id);
    expect(priced.map((r) => [r.unit, Number(r.costMicros), r.costStatus])).toEqual([
      ['input_tokens', 3_300, 'matched'], ['output_tokens', 1_375, 'matched'],
    ]);
    for (const r of priced) expect(new Date(r.billedAt).valueOf()).toBe(startedAt.valueOf());
  });

  it('are finalised and priced when the call ends', async () => {
    const { call } = await callWithDelegation();
    expect((await subRows(call.id)).map((r) => [r.unit, r.finalised, Number(r.costMicros)])).toEqual([
      ['input_tokens', true, 3_300], ['output_tokens', true, 1_375],
    ]);
  });
});
