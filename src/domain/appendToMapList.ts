/** Append in observation order, keeping the array held by existing readers. */
export const appendToMapList = <Key, Value>(
  map: Map<Key, Value[]>,
  key: NoInfer<Key>,
  value: NoInfer<Value>,
): void => {
  const values = map.get(key);
  if (values === undefined) map.set(key, [value]);
  else values.push(value);
};
