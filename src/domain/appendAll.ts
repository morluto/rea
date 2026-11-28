/**
 * Append every item in order. `target.push(...items)` passes each item as a
 * call argument, which overflows the stack once a target-sized array grows
 * past the engine's argument limit; this loop has no such limit.
 */
export const appendAll = <T>(target: T[], items: Iterable<T>): T[] => {
  // Snapshot self-appends so newly added elements are not read again.
  const source = target === items ? [...items] : items;
  for (const item of source) target.push(item);
  return target;
};
