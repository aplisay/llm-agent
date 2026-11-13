import { setPhonePeople, addPhonePerson } from '../../../../lib/pbx/directory.js';
import { directoryContext, attempt, sendWrite } from '../../../../lib/pbx/route-helpers.js';
import { PHONES_TAG, organisationIdQuery, dryRunQuery, pathId, errorResponses, ok, body } from '../../../../lib/pbx/api-docs.js';

const phoneId = pathId('phoneId', 'The id of the phone.');
const people = { type: 'array', items: { type: 'object', properties: { entryId: { type: 'string' }, name: { type: 'string' }, position: { type: 'integer' } } } };
const limit = 'A phone rings for at most one person fewer than it has lines, and a one-line phone for one. More is refused with `phone_too_small`.';

export default function (logger) {
  const put = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'phone', 'update', { gate: true });
    if (!ctx) return;
    sendWrite(res, await setPhonePeople(ctx, req.params.phoneId, req.body?.entryIds));
  });
  put.apiDoc = {
    summary: 'Set the people a phone rings for, in order.',
    description: `The first person is the first user of the phone: their own extension takes the first key. ${limit}`,
    operationId: 'setPhonePeople',
    tags: [PHONES_TAG],
    parameters: [phoneId, dryRunQuery, organisationIdQuery],
    requestBody: body({
      type: 'object',
      required: ['entryIds'],
      properties: { entryIds: { type: 'array', items: { type: 'string', format: 'uuid' } } },
    }),
    responses: { 200: ok('The people', { people }, { write: true }), ...errorResponses },
  };

  const add = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'phone', 'update', { gate: true });
    if (!ctx) return;
    sendWrite(res, await addPhonePerson(ctx, req.params.phoneId, req.body || {}), 201);
  });
  add.apiDoc = {
    summary: 'Add a person to the people a phone rings for.',
    description: limit,
    operationId: 'addPhonePerson',
    tags: [PHONES_TAG],
    parameters: [phoneId, dryRunQuery, organisationIdQuery],
    requestBody: body({
      type: 'object',
      required: ['entryId'],
      properties: { entryId: { type: 'string', format: 'uuid' }, position: { type: 'integer', minimum: 1 } },
    }),
    responses: { 201: ok('The people', { people }, { write: true }), 200: ok('The dry run', {}, { write: true }), ...errorResponses },
  };

  return { PUT: put, POST: add };
}
