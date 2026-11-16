import {
  schemaArrays,
  schemaChildren,
  schemaMaps,
  schemaSubschemas,
} from "./jsonSchemaKeywords.js";
import { isRecord } from "../kernel/isRecord.js";

type Schema = Record<string, unknown>;

/** Keywords that change how a reference resolves inside the subschema that holds them. */
const RESOLUTION_KEYWORDS = [
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$dynamicRef",
  "$recursiveAnchor",
  "$recursiveRef",
];
const DEFINITION_KEYWORDS = ["$defs", "definitions"] as const;
type DefinitionKeyword = (typeof DEFINITION_KEYWORDS)[number];
const ALTERNATIVE_KEYWORDS = new Set(["anyOf", "oneOf"]);
// Up to this serialized size an alternative stays inline: a reference and a
// definition entry add about 45 bytes, and validators compile a small
// alternative into little code. Measured on inspect_analysis_view, larger
// alternatives as definitions cut the SDK validator's compile peak from about
// 500 to 185 MiB while the schema shrank.
export const INLINE_ALTERNATIVE_BYTES = 1024;
// A definition name that is its own JSON Pointer token and URI fragment.
const PLAIN_DEFINITION_NAME = /^[A-Za-z0-9_.-]+$/u;

/**
 * Lay out a projected output schema so that clients' validators compile it
 * in bounded pieces. Validators such as Ajv compile each definition into its
 * own function, but a union with inline alternatives compiles into one
 * function that holds every alternative. For inspect_analysis_view that one
 * function covered every view result, and the MCP SDK's default validator
 * spent seconds and about 500 MiB compiling it.
 *
 * Each large union alternative becomes a definition of its own. Definitions
 * that are identical after this are merged, which also removes the copies
 * that Zod emits for equal schemas built separately.
 *
 * Moving a subschema keeps its meaning only when every reference resolves
 * against the root's definitions by a plain name and nothing re-scopes
 * resolution, so any other schema is returned unchanged.
 */
export const shareOutputDefinitions = (root: Schema): Schema => {
  const keyword = definitionKeyword(root);
  if (keyword === undefined) return root;
  const definitions = root[keyword];
  if (!isRecord(definitions)) return root;
  const prefix = `#/${keyword}/`;
  const names = new Set(Object.keys(definitions));
  if (!resolvesWithinDefinitions(root, prefix, names)) return root;
  return mergeIdenticalDefinitions(
    hoistLargeAlternatives(root, keyword, definitions, prefix),
    keyword,
    prefix,
  );
};

const definitionKeyword = (root: Schema): DefinitionKeyword | undefined => {
  const present = DEFINITION_KEYWORDS.filter((keyword) =>
    Object.hasOwn(root, keyword),
  );
  return present.length === 1 ? present[0] : undefined;
};

/**
 * Rebuild one schema level, mapping each direct subschema. Instance values
 * and unknown keywords are kept as they are. `definitions` names the root's
 * own definition map, which callers handle separately.
 */
const mapSubschemas = (
  schema: Schema,
  map: (child: unknown, keyword: string) => unknown,
  definitions?: DefinitionKeyword,
): Schema =>
  Object.fromEntries(
    Object.entries(schema).map(([keyword, value]) => {
      if (keyword === definitions) return [keyword, value];
      if (schemaMaps.has(keyword) && isRecord(value))
        return [
          keyword,
          Object.fromEntries(
            Object.entries(value).map(([name, child]) => [
              name,
              map(child, keyword),
            ]),
          ),
        ];
      if (
        (schemaArrays.has(keyword) || schemaChildren.has(keyword)) &&
        Array.isArray(value)
      )
        return [keyword, value.map((child) => map(child, keyword))];
      if (schemaChildren.has(keyword)) return [keyword, map(value, keyword)];
      return [keyword, value];
    }),
  );

const resolvesWithinDefinitions = (
  schema: unknown,
  prefix: string,
  names: ReadonlySet<string>,
): boolean => {
  if (!isRecord(schema)) return true;
  if (RESOLUTION_KEYWORDS.some((keyword) => Object.hasOwn(schema, keyword)))
    return false;
  if (Object.hasOwn(schema, "$ref")) {
    const reference = schema.$ref;
    if (typeof reference !== "string" || !reference.startsWith(prefix))
      return false;
    const name = reference.slice(prefix.length);
    if (!PLAIN_DEFINITION_NAME.test(name) || !names.has(name)) return false;
  }
  return schemaSubschemas(schema, { includeDefinitions: true }).every((child) =>
    resolvesWithinDefinitions(child, prefix, names),
  );
};

const hoistLargeAlternatives = (
  root: Schema,
  keyword: DefinitionKeyword,
  definitions: Schema,
  prefix: string,
): Schema => {
  const hoisted: Schema = {};
  const names = new Set(Object.keys(definitions));
  let next = 0;
  const freshName = (): string => {
    let name: string;
    do name = `__branch${next++}`;
    while (names.has(name));
    names.add(name);
    return name;
  };
  const visit = (schema: unknown, own?: DefinitionKeyword): unknown => {
    if (!isRecord(schema)) return schema;
    return mapSubschemas(
      schema,
      (child, parent) => {
        const rebuilt = visit(child);
        if (
          !ALTERNATIVE_KEYWORDS.has(parent) ||
          !isRecord(rebuilt) ||
          Object.hasOwn(rebuilt, "$ref") ||
          JSON.stringify(rebuilt).length <= INLINE_ALTERNATIVE_BYTES
        )
          return rebuilt;
        const name = freshName();
        hoisted[name] = rebuilt;
        return { $ref: `${prefix}${name}` };
      },
      own,
    );
  };
  const rebuiltDefinitions = Object.fromEntries(
    Object.entries(definitions).map(([name, body]) => [name, visit(body)]),
  );
  const rebuiltRoot = visit(root, keyword) as Schema;
  return {
    ...rebuiltRoot,
    [keyword]: { ...rebuiltDefinitions, ...hoisted },
  };
};

/**
 * Merge definitions with identical bodies into the first of them, repeating
 * until no two remain identical, because a merge can make the definitions
 * that reference the merged ones identical too.
 */
const mergeIdenticalDefinitions = (
  root: Schema,
  keyword: DefinitionKeyword,
  prefix: string,
): Schema => {
  let current = root;
  for (;;) {
    const definitions = current[keyword] as Schema;
    const firstByBody = new Map<string, string>();
    const merged = new Map<string, string>();
    for (const [name, body] of Object.entries(definitions)) {
      // Zod emits equal schemas with the same key order. A body that differs
      // only in key order stays separate, which costs bytes, not meaning.
      const text = JSON.stringify(body);
      const first = firstByBody.get(text);
      if (first === undefined) firstByBody.set(text, name);
      else merged.set(name, first);
    }
    if (merged.size === 0) return current;
    const redirect = (schema: unknown, own?: DefinitionKeyword): unknown => {
      if (!isRecord(schema)) return schema;
      const rebuilt = mapSubschemas(schema, (child) => redirect(child), own);
      const reference = rebuilt.$ref;
      if (typeof reference !== "string") return rebuilt;
      const target = merged.get(reference.slice(prefix.length));
      return target === undefined
        ? rebuilt
        : { ...rebuilt, $ref: `${prefix}${target}` };
    };
    current = {
      ...(redirect(current, keyword) as Schema),
      [keyword]: Object.fromEntries(
        Object.entries(definitions)
          .filter(([name]) => !merged.has(name))
          .map(([name, body]) => [name, redirect(body)]),
      ),
    };
  }
};
