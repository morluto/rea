/** Structural limits applied while traversing an unknown JSON value. */
export interface JsonLimits {
  readonly maxDepth: number;
  readonly maxStringLength: number;
  readonly maxNodes: number;
}

/** Return whether every node, key, and string fits within the supplied limits. */
export const isJsonWithinLimits = (
  root: unknown,
  limits: JsonLimits,
): boolean => {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: root, depth: 0 },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > limits.maxNodes || current.depth > limits.maxDepth)
      return false;
    if (
      typeof current.value === "string" &&
      current.value.length > limits.maxStringLength
    )
      return false;
    if (typeof current.value !== "object" || current.value === null) continue;
    for (const [key, value] of Object.entries(current.value)) {
      if (key.length > limits.maxStringLength) return false;
      pending.push({ value, depth: current.depth + 1 });
    }
  }
  return true;
};
