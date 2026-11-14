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

const yamlNodes = (root: Node): Set<Node> => {
  const nodes = new Set<Node>([root]);
  visit(root, {
    Node: (_key, node) => {
      nodes.add(node);
    },
  });
  return nodes;
};

/**
 * A reused collection keeps its aliases verbatim. Each must still resolve
 * after the edit: to an anchor inside the reused collection, or to one
 * outside the replaced value whose anchor is not being moved.
 */
const aliasesSurviveReuse = (
  collection: Node,
  editedNodes: ReadonlySet<Node>,
  retainedSources: ReadonlySet<Node>,
  document: Document,
): boolean => {
  let reusedNodes: Set<Node> | undefined;
  let survives = true;
  visit(collection, {
    Alias: (_key, alias) => {
      const target = alias.resolve(document);
      reusedNodes ??= yamlNodes(collection);
      if (
        target === undefined ||
        (!reusedNodes.has(target) &&
          (editedNodes.has(target) || retainedSources.has(target)))
      ) {
        survives = false;
        return visit.BREAK;
      }
      return undefined;
    },
  });
  return survives;
};

/** Keep source nodes and annotations when updating a value. */
export const retainYamlConfigurationSource = (
  previous: unknown,
  next: Node,
  retainedSources: ReadonlySet<Node>,
  document: Document,
  // Nodes of the value being replaced; their anchors may not survive.
  editedNodes: ReadonlySet<Node> = isNode(previous)
    ? yamlNodes(previous)
    : new Set(),
): Node => {
  if (
    (isMap(previous) || isSeq(previous)) &&
    ((isMap(previous) && isMap(next)) || (isSeq(previous) && isSeq(next)))
  ) {
    // Object projection can collapse distinct YAML keys. Reuse an unchanged
    // collection before reconstructing its children from that projection.
    if (
      !containsRetainedSource([previous], retainedSources) &&
      aliasesSurviveReuse(previous, editedNodes, retainedSources, document) &&
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
    retainYamlMapSource(previous, next, retainedSources, document, editedNodes);
  } else if (isSeq(previous) && isSeq(next)) {
    retainYamlSequenceSource(
      previous,
      next,
      retainedSources,
      document,
      editedNodes,
    );
  }
  return next;
};

const retainYamlSequenceSource = (
  previous: YAMLSeq,
  next: YAMLSeq,
  retainedSources: ReadonlySet<Node>,
  document: Document,
  editedNodes: ReadonlySet<Node>,
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
          editedNodes,
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
          editedNodes,
        )
      : item,
  );
};

/** A key spelled as an alias to a plain string scalar is that string key. */
const aliasedStringKey = (
  key: unknown,
  document: Document,
): string | undefined => {
  if (!isAlias(key)) return undefined;
  const target = key.resolve(document);
  return isScalar(target) && typeof target.value === "string"
    ? target.value
    : undefined;
};

/** A string key as YAML resolves it, whether written directly or as an alias. */
const resolvedStringKey = (
  key: unknown,
  document: Document,
): string | undefined =>
  isScalar(key) && typeof key.value === "string"
    ? key.value
    : aliasedStringKey(key, document);

const retainYamlMapSource = (
  previous: YAMLMap,
  next: YAMLMap,
  retainedSources: ReadonlySet<Node>,
  document: Document,
  editedNodes: ReadonlySet<Node>,
): void => {
  const hasMerges = retainYamlMergeSources(previous, next, document);
  const hasSourceOnlyKeys = retainProjectedYamlKeys(
    previous,
    next,
    retainedSources,
    document,
  );
  const entries = new Map(
    previous.items.flatMap((pair) => {
      const key = resolvedStringKey(pair.key, document);
      return key === undefined ? [] : [[key, pair] as const];
    }),
  );
  for (const pair of next.items) {
    if (previous.items.includes(pair)) continue;
    const key = isScalar(pair.key) ? pair.key.value : undefined;
    const prior = typeof key === "string" ? entries.get(key) : undefined;
    if (prior === undefined) continue;
    if (isAlias(prior.key)) {
      // Keep the aliased spelling while its anchor survives this edit.
      const target = prior.key.resolve(document);
      if (
        target !== undefined &&
        !editedNodes.has(target) &&
        !retainedSources.has(target)
      )
        pair.key = prior.key;
    } else
      pair.key = isNode(pair.key)
        ? retainYamlConfigurationSource(
            prior.key,
            pair.key,
            retainedSources,
            document,
            editedNodes,
          )
        : prior.key;
    if (isNode(pair.value))
      pair.value = retainYamlConfigurationSource(
        prior.value,
        pair.value,
        retainedSources,
        document,
        editedNodes,
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
      const original =
        positions.has(pair) || typeof key !== "string"
          ? pair
          : entries.get(key);
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
    if (Object.hasOwn(directValues, key)) continue;
    if (!Object.hasOwn(desired, key))
      throw new ConfigurationError(
        `Cannot remove inherited YAML setting ${JSON.stringify(key)} while retaining its merge.`,
      );
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
  for (const pair of previous.items) {
    if (isYamlMergeKey(pair.key)) continue;
    let key: string;
    const stringKey = resolvedStringKey(pair.key, document);
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
