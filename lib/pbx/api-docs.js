/**
 * Shared pieces of the OpenAPI operation documents of the directory and phone
 * routes. The schemas they name are in api/api-doc.yaml.
 */

const json = (schema) => ({ 'application/json': { schema } });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

export const DIRECTORY_TAG = 'Directory';
export const PHONES_TAG = 'Phones';

export const organisationIdQuery = {
  in: 'query',
  name: 'organisationId',
  required: false,
  schema: { type: 'string' },
  description: 'Act on this organisation in place of your own. Needs directory:readAll.',
};

export const dryRunQuery = {
  in: 'query',
  name: 'dryRun',
  required: false,
  schema: { type: 'boolean' },
  description: 'Check the request and report its effect on phones, and change nothing.',
};

export const pathId = (name, description) => ({
  in: 'path', name, required: true, schema: { type: 'string', format: 'uuid' }, description,
});

const refusal = (description) => ({ description, content: json(ref('DirectoryError')) });

export const errorResponses = {
  400: refusal('The request is not valid. `code` says why and `field` names the field at fault.'),
  403: refusal('Not permitted, or the phone system is not enabled for the organisation (`phone_system_disabled`).'),
  404: refusal('Not found.'),
  409: refusal('The request conflicts with the state of the directory. `code` says why.'),
  default: { description: 'An error occurred', content: json(ref('Error')) },
};

/** A response that returns one named object, plus the effect of the write when there is one. */
export const ok = (description, properties, { write = false } = {}) => ({
  description,
  content: json({
    type: 'object',
    properties: {
      ...properties,
      ...(write
        ? {
          dryRun: { type: 'boolean', description: 'Present and true when nothing was changed.' },
          effect: ref('DirectoryEffect'),
          changes: { type: 'array', items: ref('DirectoryChange') },
        }
        : {}),
    },
  }),
});

export const body = (schema) => ({ required: true, content: json(schema) });
export { ref };
