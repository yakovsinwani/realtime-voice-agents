/**
 * Zod → JSON Schema for provider tool declarations.
 *
 * Zod 4 ships `z.toJSONSchema()` — used when available (zod is a required
 * peer). For Zod 3 (≥3.25) a minimal structural converter covers the subset
 * that makes sense for voice-agent tool parameters: objects, strings,
 * numbers, booleans, enums, literals, arrays, records, unions,
 * optional/nullable/default, descriptions.
 */

import * as z from 'zod';

type AnyZod = any;

export function zodToJsonSchema(schema: AnyZod): Record<string, unknown> {
  let result: Record<string, unknown>;
  const native = (z as any).toJSONSchema;
  if (typeof native === 'function' && isZod4Schema(schema)) {
    try {
      result = { ...native(schema, { target: 'draft-7', io: 'input' }) };
    } catch {
      result = { type: 'object' };
    }
  } else {
    result = convertZod3(schema);
  }
  delete result.$schema;
  if (result.type === undefined && !result.anyOf && !result.oneOf && !result.enum) {
    result.type = 'object';
  }
  return result;
}

/** Zod 4 schemas carry an internal `_zod` bag; Zod 3 uses `_def.typeName`. */
function isZod4Schema(schema: AnyZod): boolean {
  return schema != null && typeof schema === 'object' && '_zod' in schema;
}

function convertZod3(schema: AnyZod): Record<string, unknown> {
  const def = schema?._def;
  if (!def) return { type: 'object' };
  const typeName: string = def.typeName ?? '';
  const description = def.description;
  const withDescription = (node: Record<string, unknown>) =>
    description ? { ...node, description } : node;

  switch (typeName) {
    case 'ZodObject': {
      const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape ?? {})) {
        const child = value as AnyZod;
        properties[key] = convertZod3(child);
        if (!isOptionalZod3(child)) required.push(key);
      }
      return withDescription({
        type: 'object',
        properties,
        ...(required.length ? { required } : {}),
        additionalProperties: false,
      });
    }
    case 'ZodString':
      return withDescription({ type: 'string' });
    case 'ZodNumber':
      return withDescription({ type: 'number' });
    case 'ZodBoolean':
      return withDescription({ type: 'boolean' });
    case 'ZodEnum':
      return withDescription({ type: 'string', enum: def.values });
    case 'ZodNativeEnum':
      return withDescription({ enum: Object.values(def.values ?? {}) });
    case 'ZodLiteral':
      return withDescription({ const: def.value });
    case 'ZodArray':
      return withDescription({ type: 'array', items: convertZod3(def.type) });
    case 'ZodRecord':
      return withDescription({
        type: 'object',
        additionalProperties: def.valueType ? convertZod3(def.valueType) : true,
      });
    case 'ZodUnion':
      return withDescription({ anyOf: (def.options ?? []).map(convertZod3) });
    case 'ZodOptional':
      return withDescription(convertZod3(def.innerType));
    case 'ZodNullable':
      return withDescription({ anyOf: [convertZod3(def.innerType), { type: 'null' }] });
    case 'ZodDefault': {
      const inner = convertZod3(def.innerType);
      return withDescription({ ...inner, default: def.defaultValue?.() });
    }
    case 'ZodEffects':
      return withDescription(convertZod3(def.schema));
    default:
      return withDescription({});
  }
}

function isOptionalZod3(schema: AnyZod): boolean {
  const typeName = schema?._def?.typeName;
  if (typeName === 'ZodOptional' || typeName === 'ZodDefault') return true;
  if (typeName === 'ZodEffects') return isOptionalZod3(schema._def.schema);
  return false;
}
