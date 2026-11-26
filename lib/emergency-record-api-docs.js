/**
 * Shared pieces of the OpenAPI operation documents of the emergency record
 * routes. The schemas they name are in api/api-doc.yaml.
 */
const json = (schema) => ({ 'application/json': { schema } });
export const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

export const EMERGENCY_RECORDS_TAG = 'Emergency Records';

export const numberParam = {
  in: 'path',
  name: 'number',
  required: true,
  schema: { type: 'string' },
  description: 'The number, as the list gives it. A leading `+` is accepted. 400 when it is not digits.',
};

const refusal = (description) => ({ description, content: json(ref('EmergencyRecordError')) });

export const record = (description) => ({ description, content: json(ref('EmergencyRecord')) });
export const body = (schema) => ({ required: true, content: json(schema) });

export const errorResponses = {
  400: refusal('The request is not valid. `field` names the field at fault.'),
  403: { description: 'The key is not the emergency service key.', content: json(ref('Error')) },
  404: refusal('No record is kept here for that number.'),
  503: refusal('`emergency_records_not_ready`: the database needs the schema upgrade.'),
  default: { description: 'An error occurred', content: json(ref('Error')) },
};

export const conflict = refusal(
  'The record is not as `expect` says. `code` is `organisation_changed`, `changed`, or `claimed` when another send holds the number.',
);
