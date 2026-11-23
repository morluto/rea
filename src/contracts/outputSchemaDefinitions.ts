import {
  mapSchemaChildren,
  schemaArrays,
  schemaChildren,
  schemaMaps,
  setOwnSchemaProperty,
} from "./jsonSchemaKeywords.js";
import { isRecord } from "../kernel/isRecord.js";

type Schema = Record<string, unknown>;

/** Keywords that change how a reference resolves inside the subschema that holds them. */
const RESOLUTION_KEYWORDS = new Set([
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$dynamicRef",
  "$recursiveAnchor",
  "$recursiveRef",
]);
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
  let found: DefinitionKeyword | undefined;
  for (const keyword of DEFINITION_KEYWORDS) {
    if (!Object.hasOwn(root, keyword)) continue;
    if (found !== undefined) return undefined;
    found = keyword;
  }
  return found;
};

const jsonStringLength = (text: string): number => {
  let len = 2;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code < 0x20 ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      return JSON.stringify(text).length;
    len += 1;
  }
  return len;
};

const exceedsJsonArrayLength = (
  items: readonly unknown[],
  limit: number,
  used: { total: number },
): boolean => {
  used.total += 2;
  if (used.total > limit) return true;
  for (let i = 0; i < items.length; i++) {
    if (i > 0) {
      used.total += 1;
      if (used.total > limit) return true;
    }
    const item = items[i];
    if (
      item === undefined ||
      typeof item === "function" ||
      typeof item === "symbol"
    ) {
      used.total += 4;
      if (used.total > limit) return true;
      continue;
    }
    if (exceedsJsonLengthStep(item, limit, used)) return true;
  }
  return false;
};

const exceedsJsonObjectLength = (
  object: Record<string, unknown>,
  limit: number,
  used: { total: number },
): boolean => {
  if (typeof (object as { toJSON?: unknown }).toJSON === "function") {
    const text = JSON.stringify(object);
    used.total += text === undefined ? 0 : text.length;
    return used.total > limit;
  }
  used.total += 2;
  if (used.total > limit) return true;
  let first = true;
  for (const key in object) {
    if (!Object.hasOwn(object, key)) continue;
    const child = object[key];
    if (
      child === undefined ||
      typeof child === "function" ||
      typeof child === "symbol"
    )
      continue;
    if (!first) {
      used.total += 1;
      if (used.total > limit) return true;
    }
    first = false;
    used.total += jsonStringLength(key) + 1;
    if (used.total > limit || exceedsJsonLengthStep(child, limit, used))
      return true;
  }
  return false;
};

const exceedsJsonLengthStep = (
  value: unknown,
  limit: number,
  used: { total: number },
): boolean => {
  if (typeof value === "string") {
    used.total += jsonStringLength(value);
    return used.total > limit;
  }
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    used.total += serialized === undefined ? 4 : serialized.length;
    return used.total > limit;
  }
  if (Array.isArray(value)) return exceedsJsonArrayLength(value, limit, used);
  return exceedsJsonObjectLength(value as Record<string, unknown>, limit, used);
};

/** Short-circuiting check equivalent to `JSON.stringify(value).length > limit`. */
const exceedsJsonLength = (value: unknown, limit: number): boolean =>
  exceedsJsonLengthStep(value, limit, { total: 0 });

const mapResolvesWithinDefinitions = (
  value: Record<string, unknown>,
  prefix: string,
  names: ReadonlySet<string>,
): boolean => {
  for (const name in value) {
    if (
      Object.hasOwn(value, name) &&
      !resolvesWithinDefinitions(value[name], prefix, names)
    )
      return false;
  }
  return true;
};

const arrayResolvesWithinDefinitions = (
  items: readonly unknown[],
  prefix: string,
  names: ReadonlySet<string>,
): boolean => {
  for (let i = 0; i < items.length; i++) {
    if (!resolvesWithinDefinitions(items[i], prefix, names)) return false;
  }
  return true;
};

const childrenResolveWithinDefinitions = (
  schema: Record<string, unknown>,
  prefix: string,
  names: ReadonlySet<string>,
): boolean => {
  for (const key in schema) {
    if (!Object.hasOwn(schema, key)) continue;
    const value = schema[key];
    if (schemaMaps.has(key)) {
      if (
        isRecord(value) &&
        !mapResolvesWithinDefinitions(value, prefix, names)
      )
        return false;
    } else if (schemaArrays.has(key)) {
      if (
        Array.isArray(value) &&
        !arrayResolvesWithinDefinitions(value, prefix, names)
      )
        return false;
    } else if (schemaChildren.has(key)) {
      const ok = Array.isArray(value)
        ? arrayResolvesWithinDefinitions(value, prefix, names)
        : resolvesWithinDefinitions(value, prefix, names);
      if (!ok) return false;
    }
  }
  return true;
};

const resolvesWithinDefinitions = (
  schema: unknown,
  prefix: string,
  names: ReadonlySet<string>,
): boolean => {
  if (!isRecord(schema)) return true;
  for (const keyword in schema) {
    if (!Object.hasOwn(schema, keyword)) continue;
    if (RESOLUTION_KEYWORDS.has(keyword)) return false;
  }
  if (Object.hasOwn(schema, "$ref")) {
    const reference = schema.$ref;
    if (typeof reference !== "string" || !reference.startsWith(prefix))
      return false;
    const name = reference.slice(prefix.length);
    if (!PLAIN_DEFINITION_NAME.test(name) || !names.has(name)) return false;
  }
  return childrenResolveWithinDefinitions(schema, prefix, names);
};

const hoistLargeAlternatives = (
  root: Schema,
  keyword: DefinitionKeyword,
  definitions: Schema,
  prefix: string,
): Schema => {
  const hoisted: Schema = {};
  let hasHoisted = false;
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
    return mapSchemaChildren(
      schema,
      (child, parent) => {
        const rebuilt = visit(child);
        if (
          !ALTERNATIVE_KEYWORDS.has(parent) ||
          !isRecord(rebuilt) ||
          Object.hasOwn(rebuilt, "$ref") ||
          !exceedsJsonLength(rebuilt, INLINE_ALTERNATIVE_BYTES)
        )
          return rebuilt;
        const name = freshName();
        setOwnSchemaProperty(hoisted, name, rebuilt);
        hasHoisted = true;
        return { $ref: `${prefix}${name}` };
      },
      own,
    );
  };
  let rebuiltDefinitions: Schema | undefined;
  for (const name in definitions) {
    if (!Object.hasOwn(definitions, name)) continue;
    const body = definitions[name];
    const rebuilt = visit(body);
    if (rebuilt !== body) {
      if (rebuiltDefinitions === undefined)
        rebuiltDefinitions = { ...definitions };
      setOwnSchemaProperty(rebuiltDefinitions, name, rebuilt);
    }
  }
  const rebuiltRoot = visit(root, keyword) as Schema;
  if (!hasHoisted && rebuiltDefinitions === undefined && rebuiltRoot === root)
    return root;
  return {
    ...rebuiltRoot,
    [keyword]: hasHoisted
      ? { ...(rebuiltDefinitions ?? definitions), ...hoisted }
      : (rebuiltDefinitions ?? definitions),
  };
};

const addReferrer = (
  referrers: Map<string, Set<string>>,
  target: string,
  caller: string,
): void => {
  let set = referrers.get(target);
  if (set === undefined) {
    set = new Set();
    referrers.set(target, set);
  }
  set.add(caller);
};

const collectDefinitionReferrers = (
  caller: string,
  node: unknown,
  prefix: string,
  referrers: Map<string, Set<string>>,
): void => {
  if (!isRecord(node)) return;
  if (Object.hasOwn(node, "$ref")) {
    const reference = node.$ref;
    if (typeof reference === "string" && reference.startsWith(prefix))
      addReferrer(referrers, reference.slice(prefix.length), caller);
  }
  for (const key in node) {
    if (!Object.hasOwn(node, key)) continue;
    const value = node[key];
    if (schemaMaps.has(key)) {
      if (!isRecord(value)) continue;
      for (const name in value) {
        if (Object.hasOwn(value, name))
          collectDefinitionReferrers(caller, value[name], prefix, referrers);
      }
    } else if (schemaArrays.has(key)) {
      if (!Array.isArray(value)) continue;
      for (let i = 0; i < value.length; i++)
        collectDefinitionReferrers(caller, value[i], prefix, referrers);
    } else if (schemaChildren.has(key)) {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++)
          collectDefinitionReferrers(caller, value[i], prefix, referrers);
      } else {
        collectDefinitionReferrers(caller, value, prefix, referrers);
      }
    }
  }
};

const redirectWithAliases = (
  node: unknown,
  aliases: ReadonlyMap<string, string>,
  prefix: string,
  options?: {
    readonly ownKeyword?: DefinitionKeyword;
    readonly onTarget?: (target: string) => void;
  },
): unknown => {
  if (!isRecord(node)) return node;
  const onTarget = options?.onTarget;
  const rebuilt = mapSchemaChildren(
    node,
    (child) =>
      redirectWithAliases(
        child,
        aliases,
        prefix,
        onTarget === undefined ? undefined : { onTarget },
      ),
    options?.ownKeyword,
  );
  if (!Object.hasOwn(rebuilt, "$ref")) return rebuilt;
  const reference = rebuilt.$ref;
  if (typeof reference !== "string" || !reference.startsWith(prefix))
    return rebuilt;
  const target = aliases.get(reference.slice(prefix.length));
  if (target === undefined) return rebuilt;
  onTarget?.(target);
  return { ...rebuilt, $ref: `${prefix}${target}` };
};

interface MergeState {
  readonly order: Map<string, number>;
  readonly live: Map<string, unknown>;
  readonly bodyText: Map<string, string>;
  readonly firstByBody: Map<string, string>;
  readonly referrers: Map<string, Set<string>>;
  readonly finalAlias: Map<string, string>;
}

const seedMergeState = (definitions: Schema, prefix: string): MergeState => {
  const order = new Map<string, number>();
  const live = new Map<string, unknown>();
  const bodyText = new Map<string, string>();
  const firstByBody = new Map<string, string>();
  const referrers = new Map<string, Set<string>>();
  const finalAlias = new Map<string, string>();
  let index = 0;
  for (const name in definitions) {
    if (!Object.hasOwn(definitions, name)) continue;
    order.set(name, index++);
    const body = definitions[name];
    // Zod emits equal schemas with the same key order. A body that differs
    // only in key order stays separate, which costs bytes, not meaning.
    const text = JSON.stringify(body);
    const first = firstByBody.get(text);
    if (first === undefined) {
      firstByBody.set(text, name);
      bodyText.set(name, text);
      live.set(name, body);
    } else {
      finalAlias.set(name, first);
    }
  }
  if (finalAlias.size > 0) {
    for (const [name, body] of live)
      collectDefinitionReferrers(name, body, prefix, referrers);
  }
  return { order, live, bodyText, firstByBody, referrers, finalAlias };
};

const runMergeRound = (
  state: MergeState,
  roundMerged: ReadonlyMap<string, string>,
  prefix: string,
): Map<string, string> => {
  const dirtySet = new Set<string>();
  for (const loser of roundMerged.keys()) {
    const callers = state.referrers.get(loser);
    if (callers === undefined) continue;
    for (const caller of callers) {
      if (state.live.has(caller)) dirtySet.add(caller);
    }
  }
  const nextMerged = new Map<string, string>();
  if (dirtySet.size === 0) return nextMerged;
  const dirty = [...dirtySet].sort(
    (left, right) => state.order.get(left)! - state.order.get(right)!,
  );
  for (const name of dirty) {
    state.firstByBody.delete(state.bodyText.get(name)!);
    const nextBody = redirectWithAliases(
      state.live.get(name),
      roundMerged,
      prefix,
      { onTarget: (target) => addReferrer(state.referrers, target, name) },
    );
    state.live.set(name, nextBody);
  }
  for (const name of dirty) {
    const text = JSON.stringify(state.live.get(name));
    const existing = state.firstByBody.get(text);
    if (existing === undefined) {
      state.firstByBody.set(text, name);
      state.bodyText.set(name, text);
    } else if (state.order.get(name)! < state.order.get(existing)!) {
      state.firstByBody.set(text, name);
      state.bodyText.set(name, text);
      state.bodyText.delete(existing);
      state.live.delete(existing);
      nextMerged.set(existing, name);
      state.finalAlias.set(existing, name);
    } else {
      state.bodyText.delete(name);
      state.live.delete(name);
      nextMerged.set(name, existing);
      state.finalAlias.set(name, existing);
    }
  }
  return nextMerged;
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
  const definitions = root[keyword] as Schema;
  const state = seedMergeState(definitions, prefix);
  let roundMerged: Map<string, string> = new Map(state.finalAlias);
  while (roundMerged.size > 0)
    roundMerged = runMergeRound(state, roundMerged, prefix);
  if (state.finalAlias.size === 0) return root;
  const resolvedAlias = new Map<string, string>();
  for (const [loser, initial] of state.finalAlias) {
    let target = initial;
    while (state.finalAlias.has(target)) target = state.finalAlias.get(target)!;
    resolvedAlias.set(loser, target);
  }
  const mergedDefinitions: Schema = {};
  for (const [name, body] of state.live)
    setOwnSchemaProperty(mergedDefinitions, name, body);
  const redirectedRoot = redirectWithAliases(root, resolvedAlias, prefix, {
    ownKeyword: keyword,
  }) as Schema;
  return { ...redirectedRoot, [keyword]: mergedDefinitions };
};
