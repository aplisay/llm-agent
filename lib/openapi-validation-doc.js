/**
 * The component schemas the request validators are built from, without their prose.
 *
 * express-openapi gives every operation its own Ajv instance and loads a deep copy of
 * every component schema into it (openapi-request-validator), so each description is
 * held once per operation: on v0.9.59 that was most of a 240 MB idle heap. Validation
 * never reads `description` or `example(s)`, so the validators get a copy without them
 * and /api-docs keeps serving the full text.
 */

const PROSE = new Set(['description', 'example', 'examples']);
// Keywords whose value maps names to schemas: the names are data, never prose.
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
// Keywords whose value is one schema, or a list of them.
const SUBSCHEMAS = new Set([
  'items', 'additionalItems', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties',
  'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'allOf', 'anyOf', 'oneOf', 'prefixItems',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function schemaWithoutProse(schema) {
  if (Array.isArray(schema)) return schema.map(schemaWithoutProse);
  if (!isObject(schema)) return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (PROSE.has(key)) continue;
    if (SCHEMA_MAPS.has(key) && isObject(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, schemaWithoutProse(sub)]));
    } else if (SUBSCHEMAS.has(key)) {
      out[key] = schemaWithoutProse(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** A copy of an OpenAPI 3 `components` object whose schemas carry no prose. */
export function componentsForValidation(components) {
  if (!isObject(components) || !isObject(components.schemas)) return components;
  return {
    ...components,
    schemas: Object.fromEntries(
      Object.entries(components.schemas).map(([name, schema]) => [name, schemaWithoutProse(schema)]),
    ),
  };
}
