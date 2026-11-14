import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  Pair,
  visit,
  YAMLMap,
  type Document,
  type Node,
  type Alias,
  type ScalarTag,
  type Tags,
  type YAMLSeq,
} from "yaml";
import { isDeepStrictEqual } from "node:util";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { retainYamlSequenceAnnotations } from "./YamlSequenceAnnotations.js";

export const yamlNumericValuesEqual = (
  left: bigint | number,
  right: bigint | number,
): boolean => {
  if (typeof left === "bigint" && typeof right === "bigint")
    return left === right;
  if (typeof left === "number" && typeof right === "number")
    return left === right || (Number.isNaN(left) && Number.isNaN(right));
  const integer = typeof left === "bigint" ? left : right;
  const number = typeof left === "number" ? left : right;
  return (
    Number.isFinite(number) &&
    Number.isInteger(number) &&
    BigInt(number) === integer
  );
};

const normalizeYamlInteger = (_key: unknown, value: unknown): unknown =>
  typeof value === "bigint" && Number.isSafeInteger(Number(value))
    ? Number(value)
    : value;

const containsRetainedSource = (
  roots: readonly unknown[],
  retainedSources: ReadonlySet<Node>,
): boolean => {
  if (retainedSources.size === 0) return false;
  let found = false;
  for (const root of roots) {
    if (!isNode(root)) continue;
    visit(root, {
      Value: (_key, node) => {
        if (retainedSources.has(node)) found = true;
      },
    });
  }
  return found;
};

/** What each alias inside `root` resolves to before an edit. */
export interface YamlAliasBinding {
  readonly target: Node;
  readonly value: unknown;
}

/** The node and value each alias inside `root` resolves to before an edit. */
export const yamlAliasValues = (
  root: unknown,
  document: Document,
): ReadonlyMap<Alias, YamlAliasBinding> => {
  const bindings = new Map<Alias, YamlAliasBinding>();
  if (!isNode(root)) return bindings;
  visit(root, {
    Alias: (_key, alias) => {
      const target = alias.resolve(document);
      if (target !== undefined)
        bindings.set(alias, { target, value: target.toJS(document) });
    },
  });
  return bindings;
};

/**
 * Replace each alias that no longer resolves to its original node, whether
 * its anchor is gone or an earlier same-name anchor now captures it, with the
 * value it resolved to before the edit. Its comments and spacing are kept.
 */
export const materializeUnresolvedYamlAliases = (
  document: Document,
  bindings: ReadonlyMap<Alias, YamlAliasBinding>,
): void => {
  if (bindings.size === 0) return;
  visit(document, {
    Alias: (_key, alias) => {
      const binding = bindings.get(alias);
      if (binding === undefined || alias.resolve(document) === binding.target)
        return undefined;
      const replacement = document.createNode(binding.value);
      if (alias.comment !== undefined) replacement.comment = alias.comment;
      if (alias.commentBefore !== undefined)
        replacement.commentBefore = alias.commentBefore;
      if (alias.spaceBefore !== undefined)
        replacement.spaceBefore = alias.spaceBefore;
      return replacement;
    },
  });
};

/** Keep source nodes and annotations when updating a value. */
export const retainYamlConfigurationSource = (
  previous: unknown,
  next: Node,
  retainedSources: ReadonlySet<Node>,
  document: Document,
): Node => {
  if (
    (isMap(previous) || isSeq(previous)) &&
    ((isMap(previous) && isMap(next)) || (isSeq(previous) && isSeq(next)))
  ) {
    // Object projection can collapse distinct YAML keys. Reuse an unchanged
    // collection before reconstructing its children from that projection.
    if (
      !containsRetainedSource([previous], retainedSources) &&
      isDeepStrictEqual(
        previous.toJS(document, { reviver: normalizeYamlInteger }),
        next.toJS(document, { reviver: normalizeYamlInteger }),
      )
    )
      return previous;
  }
  if (
    isScalar(previous) &&
    isScalar(next) &&
    (previous.value === next.value ||
      (typeof previous.value === "bigint" &&
        typeof next.value === "number" &&
        yamlNumericValuesEqual(previous.value, next.value)))
  ) {
    if (!retainedSources.has(previous)) return previous;
    const copied = previous.clone();
    if (!isScalar(copied)) throw new TypeError("Invalid YAML scalar copy");
    delete copied.anchor;
    delete copied.comment;
    delete copied.commentBefore;
    delete copied.spaceBefore;
    return copied;
  }
  // An anchor moved to a surviving consumer owns its original comments.
  // Otherwise retain annotations on the replacement without retaining the
  // old anchor, tag, or scalar spelling for the changed value.
  if (isNode(previous) && !retainedSources.has(previous)) {
    if (previous.comment !== undefined) next.comment = previous.comment;
    if (previous.commentBefore !== undefined)
      next.commentBefore = previous.commentBefore;
    if (previous.spaceBefore !== undefined)
      next.spaceBefore = previous.spaceBefore;
  }
  if (isMap(previous) && isMap(next)) {
    retainYamlMapSource(previous, next, retainedSources, document);
  } else if (isSeq(previous) && isSeq(next)) {
    retainYamlSequenceSource(previous, next, retainedSources, document);
  }
  return next;
};

const retainYamlSequenceSource = (
  previous: YAMLSeq,
  next: YAMLSeq,
  retainedSources: ReadonlySet<Node>,
  document: Document,
): void => {
  const stringItems = (items: readonly unknown[]) =>
    items.every((item) => isScalar(item) && typeof item.value === "string");
  if (stringItems(previous.items) && stringItems(next.items)) {
    retainYamlSequenceAnnotations(
      previous,
      next,
      (item) => (isScalar(item) ? item.value : undefined),
      (source, target) =>
        retainYamlConfigurationSource(
          source,
          target,
          retainedSources,
          document,
        ),
      (source) => !retainedSources.has(source),
    );
    return;
  }
  next.items = next.items.map((item, index) =>
    isNode(item)
      ? retainYamlConfigurationSource(
          previous.items[index],
          item,
          retainedSources,
          document,
        )
      : item,
  );
};

/**
 * Each pair's key as the string YAML resolves it to. A key written as an alias
 * of a string scalar counts as that string only when no other pair in the map
 * resolves to the same string; an ambiguous one stays a source-only key.
 */
const resolvedStringKeys = (
  map: YAMLMap,
  document: Document,
): Map<(typeof map.items)[number], string> => {
  const resolved = new Map<(typeof map.items)[number], string>();
  const aliased = new Map<(typeof map.items)[number], string>();
  for (const pair of map.items) {
    if (isScalar(pair.key) && typeof pair.key.value === "string")
      resolved.set(pair, pair.key.value);
    else if (isAlias(pair.key)) {
      const target = pair.key.resolve(document);
      if (isScalar(target) && typeof target.value === "string")
        aliased.set(pair, target.value);
    }
  }
  const counts = new Map<string, number>();
  for (const key of [...resolved.values(), ...aliased.values()])
    counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const [pair, key] of aliased)
    if (counts.get(key) === 1) resolved.set(pair, key);
  return resolved;
};

const retainYamlMapSource = (
  previous: YAMLMap,
  next: YAMLMap,
  retainedSources: ReadonlySet<Node>,
  document: Document,
): void => {
  const hasMerges = retainYamlMergeSources(previous, next, document);
  const hasSourceOnlyKeys = retainProjectedYamlKeys(
    previous,
    next,
    retainedSources,
    document,
  );
  const previousKeys = resolvedStringKeys(previous, document);
  // The source pair each rewritten pair replaces, including aliased keys.
  const matched = new Map<
    (typeof next.items)[number],
    (typeof previous.items)[number]
  >();
  const entries = new Map(
    [...previousKeys].map(([pair, key]) => [key, pair] as const),
  );
  for (const pair of next.items) {
    if (previous.items.includes(pair)) continue;
    const key = isScalar(pair.key) ? pair.key.value : undefined;
    const prior = typeof key === "string" ? entries.get(key) : undefined;
    if (prior === undefined) continue;
    matched.set(pair, prior);
    // An aliased key keeps its spelling; a later repair materializes it if
    // the edit leaves it without an anchor.
    pair.key = isAlias(prior.key)
      ? prior.key
      : isNode(pair.key)
        ? retainYamlConfigurationSource(
            prior.key,
            pair.key,
            retainedSources,
            document,
          )
        : prior.key;
    if (isNode(pair.value))
      pair.value = retainYamlConfigurationSource(
        prior.value,
        pair.value,
        retainedSources,
        document,
      );
  }
  if (hasSourceOnlyKeys || hasMerges) {
    // Object property ordering moves integer-like keys ahead of their
    // source neighbors. Restore source order so aliases stay after anchors.
    const positions = new Map(
      previous.items.map((pair, index) => [pair, index] as const),
    );
    const position = (pair: (typeof next.items)[number]): number => {
      const key = isScalar(pair.key) ? pair.key.value : undefined;
      const original = positions.has(pair)
        ? pair
        : (matched.get(pair) ??
          (typeof key === "string" ? entries.get(key) : undefined));
      return original === undefined
        ? Infinity
        : (positions.get(original) ?? Infinity);
    };
    next.items.sort((left, right) => position(left) - position(right));
  }
};

const isYamlMergeKey = (key: unknown): boolean =>
  isScalar(key) && typeof key.value === "symbol" && key.source === "<<";

/** Retain inheritance while materializing only explicit changes to it. */
const retainYamlMergeSources = (
  previous: YAMLMap,
  next: YAMLMap,
  document: Document,
): boolean => {
  const merges = previous.items.filter((pair) => isYamlMergeKey(pair.key));
  if (merges.length === 0) return false;
  const inherited = new YAMLMap(document.schema);
  inherited.items = merges;
  const direct = new YAMLMap(document.schema);
  direct.items = previous.items.filter((pair) => !isYamlMergeKey(pair.key));
  const project = (map: YAMLMap): Record<string, unknown> =>
    map.toJS(document, { reviver: normalizeYamlInteger }) as Record<
      string,
      unknown
    >;
  const inheritedValues = project(inherited);
  const directValues = project(direct);
  const desired = project(next);
  const inheritedUnchanged = new Set<string>();
  for (const [key, value] of Object.entries(inheritedValues)) {
    // Removing a key the merge supplies would resurrect it, even when the
    // mapping also overrides it locally.
    if (!Object.hasOwn(desired, key))
      throw new ConfigurationError(
        `Cannot remove inherited YAML setting ${JSON.stringify(key)} while retaining its merge.`,
      );
    if (Object.hasOwn(directValues, key)) continue;
    if (isDeepStrictEqual(value, desired[key])) inheritedUnchanged.add(key);
  }
  next.items = [
    ...merges,
    ...next.items.filter((pair) => {
      const key = isScalar(pair.key) ? pair.key.value : undefined;
      return typeof key !== "string" || !inheritedUnchanged.has(key);
    }),
  ];
  return true;
};

const retainProjectedYamlKeys = (
  previous: YAMLMap,
  next: YAMLMap,
  retainedSources: ReadonlySet<Node>,
  document: Document,
): boolean => {
  // A JS property can represent several distinct native YAML keys. Keep
  // those source pairs together when the property was not edited.
  const groups = new Map<string, typeof previous.items>();
  const sourceOnlyKeys = new Set<string>();
  const stringKeys = resolvedStringKeys(previous, document);
  for (const pair of previous.items) {
    if (isYamlMergeKey(pair.key)) continue;
    let key: string;
    const stringKey = stringKeys.get(pair);
    if (stringKey !== undefined) key = stringKey;
    else {
      const singleton = new YAMLMap(document.schema);
      singleton.items.push(new Pair(pair.key, null));
      const projected: unknown = singleton.toJS(document);
      if (typeof projected !== "object" || projected === null)
        throw new ConfigurationError(
          "YAML mapping key could not be resolved safely",
        );
      const [projectedKey] = Object.keys(projected);
      if (projectedKey === undefined || Object.keys(projected).length !== 1)
        throw new ConfigurationError(
          "YAML mapping key could not be resolved safely",
        );
      key = projectedKey;
      sourceOnlyKeys.add(key);
    }
    const group = groups.get(key) ?? [];
    group.push(pair);
    groups.set(key, group);
  }
  if (sourceOnlyKeys.size > 0) {
    const oldValue: unknown = previous.toJS(document, {
      reviver: normalizeYamlInteger,
    });
    const newValue: unknown = next.toJS(document, {
      reviver: normalizeYamlInteger,
    });
    if (
      typeof oldValue !== "object" ||
      oldValue === null ||
      typeof newValue !== "object" ||
      newValue === null
    )
      throw new ConfigurationError("YAML mapping could not be compared safely");
    const oldProperties = oldValue as Record<string, unknown>;
    const newProperties = newValue as Record<string, unknown>;
    const replacements = new Map<string, typeof previous.items>();
    for (const key of sourceOnlyKeys) {
      const group = groups.get(key);
      if (group === undefined) continue;
      if (
        !Object.hasOwn(newProperties, key) ||
        !isDeepStrictEqual(oldProperties[key], newProperties[key])
      )
        throw new ConfigurationError(
          `Cannot safely change YAML mapping key ${JSON.stringify(key)} because its source identity is not a plain string key.`,
        );
      if (
        containsRetainedSource(
          group.flatMap((pair) => [pair.key, pair.value]),
          retainedSources,
        )
      )
        throw new ConfigurationError(
          `Cannot safely preserve YAML mapping key ${JSON.stringify(key)} while its anchor is moved.`,
        );
      replacements.set(key, group);
    }
    next.items = next.items.flatMap((pair) => {
      const key = isScalar(pair.key) ? pair.key.value : undefined;
      const replacement =
        typeof key === "string" ? replacements.get(key) : undefined;
      return replacement ?? [pair];
    });
  }
  return sourceOnlyKeys.size > 0;
};

/** Keep a source spelling only while the selected schema resolves its value unchanged. */
const sameResolvedScalarValue = (left: unknown, right: unknown): boolean =>
  Object.is(left, right) ||
  (left instanceof Date &&
    right instanceof Date &&
    left.getTime() === right.getTime());

export const retainYamlScalarSource = (tag: Tags[number]): Tags[number] => {
  if (typeof tag === "string" || tag.collection !== undefined) return tag;
  const { stringify } = tag;
  if (stringify === undefined) return tag;
  return {
    ...tag,
    stringify: (item, context, ...rest) => {
      const { source } = item;
      if (source === undefined) return stringify(item, context, ...rest);
      const reader = context.doc.schema.tags.find(
        (candidate): candidate is ScalarTag =>
          candidate.default === true && candidate.test?.test(source) === true,
      );
      const read = reader?.resolve(
        source,
        () => undefined,
        context.doc.options,
      );
      return sameResolvedScalarValue(
        isScalar(read) ? read.value : read,
        item.value,
      )
        ? source
        : stringify(item, context, ...rest);
    },
  };
};
