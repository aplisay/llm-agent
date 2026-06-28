import { Op } from 'sequelize';
import {
  matchModelPrefix,
  effectiveAllowedModels,
  isModelAllowed,
  allowedModelsWhere,
} from '../lib/auth/model-access.js';

describe('model-access — matchModelPrefix (boundary-aware)', () => {
  test("'*' matches anything", () => {
    expect(matchModelPrefix('pipecat:ultravox/ultravox-v0.7', '*')).toBe(true);
    expect(matchModelPrefix('anything-at-all', '*')).toBe(true);
  });

  test("handler prefix 'text:' matches any text model", () => {
    expect(matchModelPrefix('text:anthropic/claude-opus-4-8', 'text:')).toBe(true);
    expect(matchModelPrefix('text:openai/gpt-4o', 'text:')).toBe(true);
  });

  test("'text:' does NOT match a different handler that merely starts with 'text'", () => {
    expect(matchModelPrefix('textual:foo/bar', 'text:')).toBe(false);
  });

  test("family prefix 'pipecat:ultravox' matches that family at a / boundary only", () => {
    expect(matchModelPrefix('pipecat:ultravox/ultravox-v0.7', 'pipecat:ultravox')).toBe(true);
    // boundary-aware: must NOT match a longer family token
    expect(matchModelPrefix('pipecat:ultravoxXL/x', 'pipecat:ultravox')).toBe(false);
  });

  test('exact full modelName matches only itself', () => {
    const exact = 'livekit:openai-realtime/gpt-realtime';
    expect(matchModelPrefix(exact, exact)).toBe(true);
    expect(matchModelPrefix('livekit:openai-realtime/gpt-realtime-mini', exact)).toBe(false);
  });

  test('a handler token without a trailing colon still matches at the : boundary', () => {
    expect(matchModelPrefix('pipecat:openai/gpt-realtime', 'pipecat')).toBe(true);
    expect(matchModelPrefix('pipecatx:openai/x', 'pipecat')).toBe(false);
  });
});

describe('model-access — effectiveAllowedModels (F1 union; empty contributes nothing)', () => {
  const org = (allowedModels = null, role = null) => ({ role, allowedModels });
  const user = (allowedModels = null, role = 'owner') => ({ role, allowedModels });

  test('both empty => unrestricted (null)', () => {
    expect(effectiveAllowedModels(user(), org())).toBeNull();
  });
  test('org restricts, user empty => org list', () => {
    expect(effectiveAllowedModels(user([]), org(['text:']))).toEqual(['text:']);
  });
  test('org empty, user restricts => user list (a user can tighten inside an open org)', () => {
    expect(effectiveAllowedModels(user(['text:']), org([]))).toEqual(['text:']);
  });
  test('org + user lists union (user widens)', () => {
    expect(effectiveAllowedModels(user(['pipecat:ultravox']), org(['text:'])).sort())
      .toEqual(['pipecat:ultravox', 'text:']);
  });
  test("'*' anywhere => unrestricted", () => {
    expect(effectiveAllowedModels(user(['text:']), org(['*']))).toBeNull();
  });
  test('role-default models feed the union (textOnly role => [text:])', () => {
    expect(effectiveAllowedModels({ role: 'textOnly' }, org())).toEqual(['text:']);
  });
  test('audioOnly role => the three modern audio handlers', () => {
    expect(effectiveAllowedModels({ role: 'audioOnly' }, org()).sort())
      .toEqual(['livekit:', 'pipecat:', 'ultravox:']);
  });
  test('org role baseline unions with a user column add', () => {
    const eff = effectiveAllowedModels({ role: 'owner', allowedModels: ['jambonz:'] }, { role: 'textOnly' });
    expect(eff.sort()).toEqual(['jambonz:', 'text:']);
  });
});

describe('model-access — isModelAllowed', () => {
  test('null list is unrestricted', () => {
    expect(isModelAllowed('anything', null)).toBe(true);
  });
  test('textOnly list permits text, rejects audio', () => {
    expect(isModelAllowed('text:anthropic/claude-opus-4-8', ['text:'])).toBe(true);
    expect(isModelAllowed('pipecat:ultravox/ultravox-v0.7', ['text:'])).toBe(false);
  });
  test('audioOnly list permits livekit/pipecat/ultravox, rejects text and jambonz', () => {
    const list = ['livekit:', 'pipecat:', 'ultravox:'];
    expect(isModelAllowed('pipecat:openai/gpt-realtime', list)).toBe(true);
    expect(isModelAllowed('ultravox:ultravox/ultravox-v0.7', list)).toBe(true);
    expect(isModelAllowed('text:openai/gpt-4o', list)).toBe(false);
    expect(isModelAllowed('jambonz:openai/gpt-4o', list)).toBe(false);
  });
});

describe('model-access — allowedModelsWhere (SQL fragment)', () => {
  test('null list => null (no constraint)', () => {
    expect(allowedModelsWhere(null, Op)).toBeNull();
  });
  test('handler prefix => single LIKE', () => {
    const w = allowedModelsWhere(['text:'], Op);
    expect(w[Op.or]).toEqual([{ modelName: { [Op.like]: 'text:%' } }]);
  });
  test('non-boundary prefix => exact OR :%/ OR /% (three terms)', () => {
    const w = allowedModelsWhere(['pipecat:ultravox'], Op);
    expect(w[Op.or]).toEqual([
      { modelName: 'pipecat:ultravox' },
      { modelName: { [Op.like]: 'pipecat:ultravox:%' } },
      { modelName: { [Op.like]: 'pipecat:ultravox/%' } },
    ]);
  });
  test('LIKE metacharacters in a prefix are escaped', () => {
    const w = allowedModelsWhere(['weird_x:'], Op);
    expect(w[Op.or]).toEqual([{ modelName: { [Op.like]: 'weird\\_x:%' } }]);
  });
  test('falsy prefixes are skipped (stays equivalent to isModelAllowed)', () => {
    const w = allowedModelsWhere(['', 'text:'], Op);
    expect(w[Op.or]).toEqual([{ modelName: { [Op.like]: 'text:%' } }]);
  });
});

describe('model-access — built-in agent prefix gating (F7)', () => {
  const SET_BUILDER = 'builtin:set-builder';
  test('unrestricted / wildcard see built-ins', () => {
    expect(isModelAllowed(SET_BUILDER, null)).toBe(true);
    expect(isModelAllowed(SET_BUILDER, ['*'])).toBe(true);
  });
  test('a text-only user does NOT see built-ins', () => {
    expect(isModelAllowed(SET_BUILDER, ['text:'])).toBe(false);
  });
  test('built-ins are grantable independently of user agents', () => {
    // allow the set-builder but NOT user text agents
    expect(isModelAllowed(SET_BUILDER, ['builtin:set-builder'])).toBe(true);
    expect(isModelAllowed('text:anthropic/claude-opus-4-8', ['builtin:set-builder'])).toBe(false);
    // `builtin:` grants all built-ins
    expect(isModelAllowed(SET_BUILDER, ['builtin:'])).toBe(true);
  });
});
