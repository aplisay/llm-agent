/**
 * The copy of the component schemas the request validators are built from. See
 * lib/openapi-validation-doc.js for why it carries no prose.
 */
import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'fs';
import yaml from 'js-yaml';
import { componentsForValidation, schemaWithoutProse } from '../lib/openapi-validation-doc.js';

describe('schemaWithoutProse', () => {
  test('drops description and examples at every level', () => {
    const schema = {
      type: 'object',
      description: 'An agent',
      example: { name: 'x' },
      properties: {
        name: { type: 'string', description: 'Its name', examples: ['Ann'] },
        options: {
          type: 'object',
          description: 'Options',
          additionalProperties: { type: 'string', description: 'One option' },
        },
        tags: { type: 'array', items: { type: 'string', description: 'A tag' } },
        voice: { oneOf: [{ type: 'string', description: 'An id' }, { $ref: '#/components/schemas/Voice' }] },
      },
    };
    expect(schemaWithoutProse(schema)).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        options: { type: 'object', additionalProperties: { type: 'string' } },
        tags: { type: 'array', items: { type: 'string' } },
        voice: { oneOf: [{ type: 'string' }, { $ref: '#/components/schemas/Voice' }] },
      },
    });
  });

  test('keeps properties that are named description or example', () => {
    const schema = {
      type: 'object',
      required: ['description'],
      properties: {
        description: { type: 'string', description: 'What the agent is for' },
        example: { type: 'boolean' },
      },
    };
    expect(schemaWithoutProse(schema)).toEqual({
      type: 'object',
      required: ['description'],
      properties: { description: { type: 'string' }, example: { type: 'boolean' } },
    });
  });

  test('keeps every keyword validation reads', () => {
    const schema = {
      type: 'string', enum: ['a', 'b'], default: 'a', format: 'uuid', nullable: true,
      pattern: '^[ab]$', minLength: 1, maxLength: 1, readOnly: true,
    };
    expect(schemaWithoutProse(schema)).toEqual(schema);
  });

  test('does not change its input', () => {
    const schema = { type: 'object', description: 'x', properties: { a: { type: 'string', description: 'y' } } };
    const before = JSON.stringify(schema);
    schemaWithoutProse(schema);
    expect(JSON.stringify(schema)).toBe(before);
  });
});

describe('componentsForValidation on api/api-doc.yaml', () => {
  const apiDoc = yaml.load(readFileSync(new URL('../api/api-doc.yaml', import.meta.url), 'utf8'));
  const stripped = componentsForValidation(apiDoc.components);

  test('keeps every schema and the other component sections', () => {
    expect(Object.keys(stripped.schemas)).toEqual(Object.keys(apiDoc.components.schemas));
    expect(stripped.securitySchemes).toBe(apiDoc.components.securitySchemes);
  });

  test('leaves no prose in the schemas and makes them much smaller', () => {
    const text = JSON.stringify(stripped.schemas);
    expect(text).not.toMatch(/"(description|example|examples)":"/);
    expect(text.length).toBeLessThan(JSON.stringify(apiDoc.components.schemas).length / 2);
  });
});
