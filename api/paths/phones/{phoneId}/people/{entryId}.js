import { removePhonePerson } from '../../../../../lib/pbx/directory.js';
import { directoryContext, attempt, sendWrite } from '../../../../../lib/pbx/route-helpers.js';
import { PHONES_TAG, organisationIdQuery, dryRunQuery, pathId, errorResponses, ok } from '../../../../../lib/pbx/api-docs.js';

export default function (logger) {
  const remove = (req, res) => attempt(res, logger, async () => {
    const ctx = await directoryContext(req, res, 'phone', 'update', { gate: true });
    if (!ctx) return;
    sendWrite(res, await removePhonePerson(ctx, req.params.phoneId, req.params.entryId));
  });
  remove.apiDoc = {
    summary: 'Take a person off a phone.',
    description: 'The phone stops ringing for them. A phone may ring for nobody: it then has no lines.',
    operationId: 'removePhonePerson',
    tags: [PHONES_TAG],
    parameters: [pathId('phoneId', 'The id of the phone.'), pathId('entryId', 'The id of the person.'), dryRunQuery, organisationIdQuery],
    responses: { 200: ok('The people left', { people: { type: 'array', items: { type: 'object' } } }, { write: true }), ...errorResponses },
  };
  return { DELETE: remove };
}
