// Vendored byte-for-byte from agent-board; see docs/operator-actions.vendor.json.
import schema from "../../docs/operator-actions.schema.json" with { type: "json" };

interface Rule {
  $ref?: string;
  type?: string;
  const?: unknown;
  enum?: unknown[];
  allOf?: Rule[];
  oneOf?: Rule[];
  required?: string[];
  properties?: Record<string, Rule>;
  additionalProperties?: boolean;
  unevaluatedProperties?: boolean;
  items?: Rule;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
}

/** The keywords below, and no others; test/actions.test.ts refuses a schema using more. */
export const KEYWORDS = ["$schema", "title", "$defs", "$ref", "type", "const", "enum", "allOf", "oneOf", "required", "properties", "additionalProperties", "unevaluatedProperties", "items", "minItems", "maxItems", "minLength", "maxLength", "pattern", "minimum", "maximum"];

function typed(value: unknown, type: string): boolean {
  switch (type) {
    case "null": return value === null;
    case "string": return typeof value === "string";
    case "integer": return Number.isInteger(value);
    case "array": return Array.isArray(value);
    case "object": return !!value && typeof value === "object" && !Array.isArray(value);
    default: return false;
  }
}

// Returns the object properties this rule evaluated (for unevaluatedProperties),
// or undefined when the value does not match. Annotations from failed
// subschemas are dropped, as JSON Schema 2020-12 requires.
function evaluate(value: unknown, rule: Rule): Set<string> | undefined {
  const seen = new Set<string>();
  const merge = (r: Rule): boolean => { const e = evaluate(value, r); e?.forEach((k) => seen.add(k)); return !!e; };
  if (rule.$ref && !merge((schema.$defs as Record<string, Rule>)[rule.$ref.replace(/^#\/\$defs\//, "")] ?? { type: "never" })) return;
  if (rule.allOf && !rule.allOf.every(merge)) return;
  if (rule.oneOf) {
    const hits = rule.oneOf.map((r) => evaluate(value, r)).filter((e) => !!e);
    if (hits.length !== 1) return;
    hits[0]!.forEach((k) => seen.add(k));
  }
  if (Object.hasOwn(rule, "const") && value !== rule.const) return;
  if (rule.enum && !rule.enum.includes(value)) return;
  if (rule.type && !typed(value, rule.type)) return;
  if (typeof value === "string") {
    // Lengths count code points, and patterns are Unicode regular expressions.
    const length = [...value].length;
    if (length < (rule.minLength ?? 0) || length > (rule.maxLength ?? Infinity) || (rule.pattern && !new RegExp(rule.pattern, "u").test(value))) return;
  }
  if (typeof value === "number" && (value < (rule.minimum ?? -Infinity) || value > (rule.maximum ?? Infinity))) return;
  if (Array.isArray(value) && (value.length < (rule.minItems ?? 0) || value.length > (rule.maxItems ?? Infinity) || (rule.items && !value.every((v) => evaluate(v, rule.items!))))) return;
  if (typed(value, "object")) {
    const o = value as Record<string, unknown>;
    if (!(rule.required ?? []).every((k) => Object.hasOwn(o, k))) return;
    for (const [k, r] of Object.entries(rule.properties ?? {})) {
      if (!Object.hasOwn(o, k)) continue;
      if (!evaluate(o[k], r)) return;
      seen.add(k);
    }
    if (rule.additionalProperties === false && !Object.keys(o).every((k) => Object.hasOwn(rule.properties ?? {}, k))) return;
    if (rule.unevaluatedProperties === false && !Object.keys(o).every((k) => seen.has(k))) return;
  }
  return seen;
}

export function matchesActionSchema(value: unknown): boolean { return !!evaluate(value, schema as Rule); }

/** The action `type`s the schema defines, so a proposal naming another can say which. */
export const ACTION_KINDS: ReadonlySet<string> = new Set((schema.$defs.action.oneOf as Rule[]).flatMap((r) => {
  const t = r.properties?.type;
  return t?.enum ?? (t && Object.hasOwn(t, "const") ? [t.const] : []);
}).filter((k): k is string => typeof k === "string"));
