import {
  isMap,
  isNode,
  isScalar,
  isSeq,
  type Node,
  type ScalarTag,
  type Tags,
} from "yaml";
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

/** Keep source annotations and unchanged scalars when updating a value. */
export const retainYamlConfigurationSource = (
  previous: unknown,
  next: Node,
  retainedSources: ReadonlySet<Node>,
): Node => {
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
    const entries = new Map(
      previous.items.flatMap((pair) =>
        isScalar(pair.key) && typeof pair.key.value === "string"
          ? [[pair.key.value, pair] as const]
          : [],
      ),
    );
    for (const pair of next.items) {
      const key = isScalar(pair.key) ? pair.key.value : undefined;
      const prior = typeof key === "string" ? entries.get(key) : undefined;
      if (prior === undefined) continue;
      pair.key = isNode(pair.key)
        ? retainYamlConfigurationSource(prior.key, pair.key, retainedSources)
        : prior.key;
      if (isNode(pair.value))
        pair.value = retainYamlConfigurationSource(
          prior.value,
          pair.value,
          retainedSources,
        );
    }
  } else if (isSeq(previous) && isSeq(next)) {
    const stringItems = (items: readonly unknown[]) =>
      items.every((item) => isScalar(item) && typeof item.value === "string");
    if (stringItems(previous.items) && stringItems(next.items))
      retainYamlSequenceAnnotations(
        previous,
        next,
        (item) => (isScalar(item) ? item.value : undefined),
        (source, target) =>
          retainYamlConfigurationSource(source, target, retainedSources),
        (source) => !retainedSources.has(source),
      );
    else
      next.items = next.items.map((item, index) =>
        isNode(item)
          ? retainYamlConfigurationSource(
              previous.items[index],
              item,
              retainedSources,
            )
          : item,
      );
  }
  return next;
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
