import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { zodToJsonSchema } from './json-schema.js';
import { tool } from './tool.js';

describe('zodToJsonSchema', () => {
  it('converts an installed-zod object schema to JSON Schema', () => {
    const schema = zodToJsonSchema(
      z.object({
        city: z.string().describe('City name'),
        days: z.number().optional(),
        unit: z.enum(['c', 'f']),
      }),
    ) as any;
    expect(schema.$schema).toBeUndefined();
    expect(schema.type).toBe('object');
    expect(schema.properties.city.type).toBe('string');
    expect(schema.properties.city.description).toBe('City name');
    expect(schema.properties.unit.enum).toEqual(['c', 'f']);
    expect(schema.required).toContain('city');
    expect(schema.required).toContain('unit');
    expect(schema.required).not.toContain('days');
  });

  it('converts a Zod-3-shaped schema via the structural fallback', () => {
    // Hand-built _def tree mimicking zod@3 internals.
    const fakeString = { _def: { typeName: 'ZodString', description: 'Name' } };
    const fakeOptionalNumber = {
      _def: { typeName: 'ZodOptional', innerType: { _def: { typeName: 'ZodNumber' } } },
    };
    const fakeObject = {
      _def: {
        typeName: 'ZodObject',
        shape: () => ({ name: fakeString, age: fakeOptionalNumber }),
      },
      safeParse: () => ({ success: true, data: {} }),
    };
    const schema = zodToJsonSchema(fakeObject) as any;
    expect(schema).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name' },
        age: { type: 'number' },
      },
      required: ['name'],
      additionalProperties: false,
    });
  });
});

describe('tool()', () => {
  it('computes parametersJsonSchema and defaults strategy to sync', () => {
    const t = tool({
      name: 'get_weather',
      description: 'Get weather',
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, temp: 20 }),
    });
    expect(t.strategy).toBe('sync');
    expect((t.parametersJsonSchema as any).properties.city.type).toBe('string');
  });

  it('rejects invalid tool names', () => {
    expect(() =>
      tool({
        name: 'bad name!',
        description: 'x',
        parameters: z.object({}),
        execute: async () => ({}),
      }),
    ).toThrow('invalid');
  });
});
