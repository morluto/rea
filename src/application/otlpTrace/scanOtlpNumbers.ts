import { OTLP_TRACE_MAX_ATTRIBUTES_PER_SPAN } from "../../domain/otlpTrace/otlpTrace.js";

/** Bound retained source-coordinate metadata independently of input byte size. */
export const OTLP_MAX_LOSSY_FIELDS = 16_384;
export class OtlpNumberScanLimitError extends Error {}

type JsonObject = Record<string, unknown>;
type Plan =
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, Plan>> }
  | {
      readonly kind: "array";
      readonly item: Plan;
      readonly attributes?: "span" | "resource";
    }
  | { readonly kind: "number" };

const numeric: Plan = { kind: "number" };
const value: Plan = { kind: "object", fields: { intValue: numeric } };
const attribute: Plan = { kind: "object", fields: { value } };
const attributes = (kind: "span" | "resource"): Plan => ({
  kind: "array",
  item: attribute,
  attributes: kind,
});
const span: Plan = {
  kind: "object",
  fields: {
    startTimeUnixNano: numeric,
    endTimeUnixNano: numeric,
    attributes: attributes("span"),
  },
};
const scope: Plan = {
  kind: "object",
  fields: { spans: { kind: "array", item: span } },
};
const resource: Plan = {
  kind: "object",
  fields: { attributes: attributes("resource") },
};
const group: Plan = {
  kind: "object",
  fields: { resource, scopeSpans: { kind: "array", item: scope } },
};
const root: Plan = {
  kind: "object",
  fields: { resourceSpans: { kind: "array", item: group } },
};

const record = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Scan source coordinates only for numeric values that the OTLP inventory may read.
 * The native parser has already validated the JSON. Unselected values are skipped
 * without constructing tokens or recursively walking their object representation. */
export const scanOtlpNumbers = (
  text: string,
  document: unknown,
  exact: (value: number, source: string) => boolean,
): ((holder: object, key: string) => boolean) => {
  const lossy = new WeakMap<object, Set<string>>();
  let marked = 0;
  let position = 0;
  const whitespace = () => {
    while (" \t\r\n".includes(text[position] ?? "\0")) position++;
  };
  const stringEnd = () => {
    position++;
    while (position < text.length) {
      const c = text[position++];
      if (c === "\\") position++;
      else if (c === '"') return;
    }
  };
  const skip = () => {
    whitespace();
    const first = text[position];
    if (first === '"') {
      stringEnd();
      return;
    }
    if (first === "{" || first === "[") {
      let depth = 0;
      do {
        const c = text[position];
        if (c === '"') stringEnd();
        else {
          position++;
          if (c === "{" || c === "[") depth++;
          else if (c === "}" || c === "]") depth--;
        }
      } while (depth > 0 && position < text.length);
      return;
    }
    while (position < text.length && !",}] \t\r\n".includes(text[position]!))
      position++;
  };
  const visit = (plan: Plan, node: unknown): void => {
    whitespace();
    if (plan.kind === "object" && text[position] === "{" && record(node)) {
      position++;
      whitespace();
      // JSON.parse keeps the last occurrence of each object key. Find those
      // source coordinates before interpreting children, so overwritten arrays
      // never acquire metadata for the surviving parsed values.
      const members = new Map<
        string,
        { readonly child: Plan; readonly from: number; readonly end: number }
      >();
      while (text[position] !== "}") {
        const start = position;
        stringEnd();
        const key: string = JSON.parse(text.slice(start, position));
        whitespace();
        position++;
        whitespace();
        const child = Object.hasOwn(plan.fields, key)
          ? plan.fields[key]
          : undefined;
        const from = position;
        skip();
        if (child !== undefined)
          members.set(key, { child, from, end: position });
        whitespace();
        if (text[position] === ",") {
          position++;
          whitespace();
        } else break;
      }
      const objectEnd = position + 1;
      for (const [key, { child, from, end }] of members) {
        position = from;
        if (child.kind === "number") {
          const current = node[key];
          const numericSource =
            text[from] === "-" ||
            (text[from] !== undefined &&
              text[from]! >= "0" &&
              text[from]! <= "9");
          if (
            typeof current === "number" &&
            numericSource &&
            (end - from > 256 || !exact(current, text.slice(from, end)))
          ) {
            if (marked >= OTLP_MAX_LOSSY_FIELDS)
              throw new OtlpNumberScanLimitError(
                "Too many imprecise numeric fields to retain source coordinates.",
              );
            marked++;
            const fields = lossy.get(node) ?? new Set<string>();
            fields.add(key);
            lossy.set(node, fields);
          }
        } else visit(child, node[key]);
      }
      position = objectEnd;
    } else if (
      plan.kind === "array" &&
      text[position] === "[" &&
      Array.isArray(node)
    ) {
      position++;
      whitespace();
      let index = 0;
      let retained = 0;
      while (text[position] !== "]") {
        const item = node[index];
        let selected = true;
        if (plan.attributes === "span") {
          selected = record(item) && typeof item.key === "string";
        } else if (plan.attributes === "resource") {
          selected = !(
            record(item) &&
            item.key === "service.name" &&
            record(item.value) &&
            typeof item.value.stringValue === "string"
          );
        }
        if (plan.attributes !== undefined && selected) {
          retained++;
          selected = retained <= OTLP_TRACE_MAX_ATTRIBUTES_PER_SPAN;
        }
        if (selected) visit(plan.item, item);
        else skip();
        index++;
        whitespace();
        if (text[position] === ",") {
          position++;
          whitespace();
        } else break;
      }
      position++;
    } else skip();
  };
  visit(root, document);
  return (holder, key) => lossy.get(holder)?.has(key) === true;
};
