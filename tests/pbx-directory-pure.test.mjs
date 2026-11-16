/**
 * The pure parts of the completed directory API: refs in a batch, what the
 * crawl may do, the next extension number, and the knowledge service's role.
 */
import { resolveRefs, CRAWL_OPS, BATCH_OPS, causeOfOp, isKnowledgeService, mayActAsCrawl } from '../lib/pbx/batch.js';
import { nextExtensionNumber } from '../lib/pbx/next-number.js';
import { statementsFor, can } from '../lib/auth/permissions.js';

describe('refs in a batch', () => {
  const refs = new Map([['dan', 'id-dan'], ['wh', 'id-wh']]);

  test('a whole "$name" of an earlier op becomes its id, anywhere in the op', () => {
    expect(resolveRefs({ op: 'extension.create', extension: { entryId: '$wh', members: ['$dan', 'id-x'] } }, refs))
      .toEqual({ op: 'extension.create', extension: { entryId: 'id-wh', members: ['id-dan', 'id-x'] } });
  });

  test('text that only looks like a ref is left alone', () => {
    expect(resolveRefs({ about: '$dan is here', notes: '$5 off', other: '$nobody' }, refs))
      .toEqual({ about: '$dan is here', notes: '$5 off', other: '$nobody' });
  });
});

describe('what the crawl may do', () => {
  test('add and update entries, and give them extensions on their own phone system', () => {
    expect(CRAWL_OPS({ op: 'entry.create' })).toBe(true);
    expect(CRAWL_OPS({ op: 'entry.update' })).toBe(true);
    expect(CRAWL_OPS({ op: 'extension.create', extension: { number: '310' } })).toBe(true);
    expect(CRAWL_OPS({ op: 'extension.create', extension: { number: '310', type: 'connection' } })).toBe(true);
  });

  test('nothing else', () => {
    expect(CRAWL_OPS({ op: 'extension.create', extension: { type: 'ring_all' } })).toBe(false);
    for (const op of BATCH_OPS.filter((name) => !['entry.create', 'entry.update', 'extension.create'].includes(name))) {
      expect(CRAWL_OPS({ op })).toBe(false);
    }
  });

  test('every op has a cause for the phone change record', () => {
    for (const op of BATCH_OPS) expect(causeOfOp({ op }).kind).not.toBe('batch');
  });
});

describe('the next extension number', () => {
  test('the lowest free number of the most common length', () => {
    expect(nextExtensionNumber(['100', '101', '103', '200'])).toBe('102');
    expect(nextExtensionNumber([])).toBe('100');
    expect(nextExtensionNumber(['10', '11', '2000'])).toBe('12');
  });

  test('a tie goes to the longer length', () => {
    expect(nextExtensionNumber(['10', '1000'])).toBe('1001');
  });

  test('the length of near, when given', () => {
    expect(nextExtensionNumber(['100'], '4000')).toBe('1000');
    expect(nextExtensionNumber(['1', '2'], '7')).toBe('3');
    expect(nextExtensionNumber(['100'], 'abc')).toBe('101');
  });

  test('never an emergency number or one that begins with one', () => {
    const taken = Array.from({ length: 11 }, (_, i) => String(100 + i)).concat(['111']);
    expect(nextExtensionNumber(taken)).toBe('113');
    const ones = Array.from({ length: 9 }, (_, i) => String(i + 1));
    expect(nextExtensionNumber(ones, '1')).toBeNull();
  });
});

describe('the knowledge service', () => {
  test('reads, searches and writes any directory, and nothing else', () => {
    expect(statementsFor('knowledgeService')).toEqual({ directory: ['read', 'update', 'lookup', 'readAll'] });
    expect(can({ role: 'knowledgeService' }, 'phone', 'read')).toBe(false);
    expect(can({ role: 'knowledgeService' }, 'organisation', 'read')).toBe(false);
  });

  test('is known by its role or by the role pinned on its key', () => {
    expect(isKnowledgeService({ role: 'knowledgeService' })).toBe(true);
    expect(isKnowledgeService({ role: 'owner', _roleRestriction: 'knowledgeService' })).toBe(true);
    expect(isKnowledgeService({ role: 'superAdmin' })).toBe(false);
  });

  test('only a principal with no organisation that reads every directory may write as the crawl', () => {
    expect(mayActAsCrawl({ role: 'knowledgeService', organisationId: null })).toBe(true);
    expect(mayActAsCrawl({ role: 'superAdmin', organisationId: 'org-1' })).toBe(false);
    expect(mayActAsCrawl({ role: 'owner', organisationId: null })).toBe(false);
  });
});
