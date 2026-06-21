import type { JsonRecord } from './types';

export type FieldType =
  | 'string'
  | 'text'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'enum'
  | 'array';

export interface FieldSpec {
  name: string;
  type: FieldType;
  description: string;
  required: boolean;
  identity: boolean;
  enum?: string[];
  item_type?: FieldType;
  examples: unknown[];
}

export interface EntityType {
  name: string;
  description: string;
  fields: FieldSpec[];
  summary_field: string | null;
  aliases: string[];
  graph_route: boolean;
  tabular: boolean;
}

export interface DomainSchema {
  domain: string;
  name: string;
  version: number;
  description: string;
  vocabulary: Record<string, string>;
  entities: EntityType[];
  relationships: Array<{
    name: string;
    kind: 'parent' | 'ref';
    from_type: string;
    to_type: string;
    description: string;
  }>;
}

export interface SchemaInferenceInput {
  domain: string;
  records?: JsonRecord[];
  sample_texts?: string[];
  name?: string;
}

const IDENTITY_NAMES = new Set(['id', 'uuid', 'slug', 'key', 'code', 'name', 'title', 'email', 'ticker']);

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'corpus';
}

function pascal(value: string): string {
  const words = slug(value).split(/[-_]+/).filter(Boolean);
  const base = words.map((word) => word[0]?.toUpperCase() + word.slice(1)).join('') || 'Corpus';
  return base.endsWith('s') && base.length > 3 ? base.slice(0, -1) : base;
}

function fieldName(value: string): string {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const safe = cleaned.replace(/^[0-9]+/, '');
  return safe || 'field';
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}[T ][0-9:.+-Z]+/.test(value);
}

function primitiveType(value: unknown): FieldType {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') {
    if (isDate(value)) return 'date';
    if (isDateTime(value)) return 'datetime';
    return value.length > 220 ? 'text' : 'string';
  }
  return 'string';
}

function mergeTypes(types: FieldType[]): FieldType {
  const unique = new Set(types);
  if (unique.size === 1) return types[0] ?? 'string';
  if (unique.has('text')) return 'text';
  if (unique.has('string')) return 'string';
  if (unique.has('number') && unique.has('integer')) return 'number';
  if (unique.has('array')) return 'array';
  return 'string';
}

function parseCsv(text: string): JsonRecord[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0] ?? '').map((part) => fieldName(part));
  if (header.length < 2) return [];
  return lines.slice(1, 51).map((line) => {
    const values = splitCsvLine(line);
    const row: JsonRecord = {};
    header.forEach((name, i) => {
      const raw = values[i]?.trim() ?? '';
      const numeric = Number(raw);
      row[name] = raw && Number.isFinite(numeric) ? numeric : raw;
    });
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function scalarContext(record: JsonRecord): JsonRecord {
  return Object.entries(record).reduce<JsonRecord>((out, [key, value]) => {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) out[key] = value;
    return out;
  }, {});
}

function recordsFromJsonValue(value: unknown, parent: JsonRecord = {}, depth = 0): JsonRecord[] {
  if (depth > 6) return [];
  if (Array.isArray(value)) {
    const direct = value.filter(isRecord).map((item) => ({ ...parent, ...item }));
    if (direct.length > 0) return direct.slice(0, 500);
    return value.flatMap((item) => recordsFromJsonValue(item, parent, depth + 1)).slice(0, 500);
  }
  if (!isRecord(value)) return [];
  const context = { ...parent, ...scalarContext(value) };
  const nested = Object.values(value)
    .flatMap((child) => recordsFromJsonValue(child, context, depth + 1))
    .slice(0, 500);
  return nested.length > 0 ? nested : [{ ...parent, ...value }];
}

export function recordsFromUnknown(value: unknown): JsonRecord[] {
  const jsonRecords = recordsFromJsonValue(value);
  if (jsonRecords.length > 0) return jsonRecords;
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    return recordsFromUnknown(JSON.parse(trimmed) as unknown);
  } catch {
    // Continue with line-oriented formats.
  }
  const ndjson = trimmed
    .split(/\r?\n/)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : null;
      } catch {
        return null;
      }
    })
    .filter((item): item is JsonRecord => Boolean(item));
  if (ndjson.length > 0) return ndjson;
  return parseCsv(trimmed);
}

function examples(values: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const comparable = JSON.stringify(value);
    if (out.some((existing) => JSON.stringify(existing) === comparable)) continue;
    out.push(value);
    if (out.length >= 5) break;
  }
  return out;
}

function inferFields(records: JsonRecord[]): FieldSpec[] {
  const keys = [...new Set(records.flatMap((record) => Object.keys(record)))].map(fieldName);
  const fields = keys.map((name) => {
    const values = records.map((record) => record[name]).filter((value) => value !== undefined);
    const types = values.map(primitiveType);
    const valueExamples = examples(values);
    const stringExamples = valueExamples.filter((value): value is string => typeof value === 'string');
    const uniqueStrings = new Set(stringExamples);
    const enumValues = stringExamples.length >= 2 && uniqueStrings.size <= Math.min(12, records.length)
      ? [...uniqueStrings].slice(0, 12)
      : undefined;
    const baseType = mergeTypes(types);
    const type = enumValues && baseType === 'string' ? 'enum' : baseType;
    const lower = name.toLowerCase();
    return {
      name,
      type,
      description: `Extracted ${name.replaceAll('_', ' ')} from the source record.`,
      required: values.length === records.length,
      identity: IDENTITY_NAMES.has(lower) || lower.endsWith('_id'),
      ...(enumValues ? { enum: enumValues } : {}),
      ...(type === 'array' ? { item_type: 'string' as FieldType } : {}),
      examples: valueExamples,
    };
  });
  if (!fields.some((field) => field.identity) && fields[0]) fields[0].identity = true;
  return fields;
}

function relationshipNameFromField(field: string, identityField: string): string | null {
  const lower = field.toLowerCase();
  if (lower === identityField.toLowerCase()) return null;
  if (lower === 'parent' || lower === 'parent_id') return 'parent';
  if (lower.endsWith('_ids') && lower.length > 4) return lower.slice(0, -4);
  if (lower.endsWith('_id') && lower.length > 3) return lower.slice(0, -3);
  return null;
}

function inferRelationships(entityName: string, fields: FieldSpec[]): DomainSchema['relationships'] {
  const identityField = fields.find((field) => field.identity)?.name ?? fields[0]?.name ?? 'id';
  const seen = new Set<string>();
  const relationships: DomainSchema['relationships'] = [];
  for (const field of fields) {
    const name = relationshipNameFromField(field.name, identityField);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    relationships.push({
      name,
      kind: name === 'parent' ? 'parent' : 'ref',
      from_type: entityName,
      to_type: entityName,
      description: `Inferred from ${field.name} references to ${identityField}.`,
    });
  }
  return relationships;
}

function relationshipPrefixFromIdentityField(field: string, primaryIdentityField: string): string | null {
  const lower = field.toLowerCase();
  if (lower === primaryIdentityField.toLowerCase()) return null;
  if (lower === 'parent_id' || lower === 'parent') return null;
  if (lower.endsWith('_id') && lower.length > 3) return lower.slice(0, -3);
  if (lower.endsWith('_ids') && lower.length > 4) return lower.slice(0, -4);
  return null;
}

function inferRelatedEntityTypes(records: JsonRecord[], fields: FieldSpec[]): EntityType[] {
  const primaryIdentity = fields.find((field) => field.identity)?.name ?? fields[0]?.name ?? 'id';
  const fieldNames = new Set(fields.map((field) => field.name));
  const prefixes = new Set<string>();
  for (const field of fields) {
    const prefix = relationshipPrefixFromIdentityField(field.name, primaryIdentity);
    if (!prefix) continue;
    const hasEntitySpecificFields = [...fieldNames].some((name) =>
      name.toLowerCase().startsWith(`${prefix}_`) && name.toLowerCase() !== field.name.toLowerCase(),
    );
    if (hasEntitySpecificFields) prefixes.add(prefix);
  }
  const entities: EntityType[] = [];
  for (const prefix of prefixes) {
    const projected = records
      .map((record) => Object.entries(record).reduce<JsonRecord>((out, [key, value]) => {
        if (key.toLowerCase().startsWith(`${prefix}_`)) out[key] = value;
        return out;
      }, {}))
      .filter((record) => Object.keys(record).length > 0);
    if (projected.length === 0) continue;
    const relatedFields = inferFields(projected);
    const identityField = relatedFields.find((field) => field.name.toLowerCase() === `${prefix}_id`)
      ?? relatedFields.find((field) => field.identity)
      ?? relatedFields[0];
    if (!identityField) continue;
    for (const field of relatedFields) field.identity = field.name === identityField.name;
    const summaryField = relatedFields.find((field) => field.name.toLowerCase() === `${prefix}_name`)?.name
      ?? relatedFields.find((field) => ['name', 'title'].includes(field.name.toLowerCase()))?.name
      ?? identityField.name;
    entities.push({
      name: `${pascal(prefix)}Record`,
      description: `Related ${prefix.replaceAll('_', ' ')} entity inferred from ${prefix}_* fields.`,
      fields: relatedFields,
      summary_field: summaryField,
      aliases: [prefix],
      graph_route: true,
      tabular: true,
    });
  }
  return entities;
}

function retargetRelationships(
  relationships: DomainSchema['relationships'],
  relatedEntities: EntityType[],
): DomainSchema['relationships'] {
  const byAlias = new Map<string, EntityType>();
  for (const entity of relatedEntities) {
    for (const alias of entity.aliases) byAlias.set(alias.toLowerCase(), entity);
  }
  return relationships.map((relationship) => {
    const target = byAlias.get(relationship.name.toLowerCase());
    if (!target) return relationship;
    const identity = target.fields.find((field) => field.identity)?.name ?? target.fields[0]?.name ?? 'id';
    return {
      ...relationship,
      to_type: target.name,
      description: `Inferred from ${relationship.name}_id references to ${target.name}.${identity}.`,
    };
  });
}

function vocabularyFromText(samples: string[]): Record<string, string> {
  const counts = new Map<string, number>();
  for (const sample of samples) {
    for (const token of sample.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .reduce<Record<string, string>>((out, [term]) => {
      out[term] = `Frequent term observed in the ${samples.length} sample text(s).`;
      return out;
    }, {});
}

export function inferSchema(input: SchemaInferenceInput): DomainSchema {
  const domain = slug(input.domain);
  const textSamples = (input.sample_texts ?? []).filter(Boolean);
  const records = [
    ...(input.records ?? []),
    ...textSamples.flatMap(recordsFromUnknown),
  ].slice(0, 200);
  const entityName = `${pascal(domain)}Record`;
  const fields = records.length > 0
    ? inferFields(records)
    : [
        {
          name: 'title',
          type: 'string' as FieldType,
          description: 'Human-readable title or heading for the document.',
          required: false,
          identity: true,
          examples: [],
        },
        {
          name: 'content',
          type: 'text' as FieldType,
          description: 'Primary document text or body content.',
          required: true,
          identity: false,
          examples: textSamples.slice(0, 2).map((sample) => sample.slice(0, 160)),
        },
      ];
  const summaryField = fields.find((field) => ['name', 'title'].includes(field.name.toLowerCase()))?.name
    ?? fields.find((field) => field.type === 'text')?.name
    ?? fields[0]?.name
    ?? null;
  const relationships = inferRelationships(entityName, fields);
  const relatedEntities = records.length > 0 ? inferRelatedEntityTypes(records, fields) : [];
  const allRelationships = retargetRelationships(relationships, relatedEntities);
  return {
    domain,
    name: input.name?.trim() || 'inferred',
    version: 1,
    description: records.length > 0
      ? `Schema inferred from ${records.length} structured record(s).`
      : `Schema inferred from ${textSamples.length} text sample(s).`,
    vocabulary: vocabularyFromText(textSamples),
    entities: [
      {
        name: entityName,
        description: `Primary entity inferred for the ${domain} corpus.`,
        fields,
        summary_field: summaryField,
        aliases: [domain],
        graph_route: true,
        tabular: records.length > 0,
      },
      ...relatedEntities,
    ],
    relationships: allRelationships,
  };
}
