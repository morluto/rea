/**
 * Append items in order, as `target.push(...items)` would, without turning
 * each item into a call argument. Engines bound argument count by stack size,
 * so spreading a data-sized collection throws `RangeError`. The count is read
 * once, so appending an array to itself duplicates it like a spread.
 */
export const appendAll = <Item>(
  target: Item[],
  items: readonly NoInfer<Item>[],
): void => {
  const count = items.length;
  for (let index = 0; index < count; index += 1)
    target.push(items[index] as Item);
};
