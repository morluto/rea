/** Append to an indexed group, retaining its array and insertion order. */
export const appendToBucket = <Key, Value>(
  map: Map<Key, Value[]>,
  key: Key,
  value: Value,
): void => {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else bucket.push(value);
};
