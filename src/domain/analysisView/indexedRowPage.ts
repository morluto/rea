import type { JsonValue } from "../jsonValue.js";

/** Copy the selected columns of one retained row; the source index always stays. */
export const selectRowFields = (
  row: object,
  index: number,
  fields: ReadonlySet<string> | undefined,
): { index: number } & Record<string, JsonValue> => {
  const item: { index: number } & Record<string, JsonValue> = { index };
  const values = row as Readonly<Record<string, JsonValue | undefined>>;
  for (const key of Object.keys(values)) {
    const value = values[key];
    if (value !== undefined && (fields === undefined || fields.has(key)))
      item[key] = value;
  }
  return item;
};

/** Direct batch lookup visits selected indices only, in source order. */
function* rowIndices(length: number, indices: readonly number[] | undefined) {
  if (indices === undefined) {
    for (let index = 0; index < length; index++) yield index;
  } else {
    for (const index of [...new Set(indices)].sort((a, b) => a - b))
      if (index < length) yield index;
  }
}

/**
 * Page retained rows by source index. Filters intersect with `indices`; the
 * page offset counts matching rows, and `total` is every match.
 */
export const pageIndexedRows = <Row extends object>(
  rows: readonly Row[],
  view: {
    readonly indices?: readonly number[] | undefined;
    readonly offset: number;
    readonly limit: number;
    readonly fields?: readonly string[] | undefined;
  },
  matches: ((row: Row, index: number) => boolean) | undefined,
) => {
  const fields = view.fields === undefined ? undefined : new Set(view.fields);
  const items: ({ index: number } & Record<string, JsonValue>)[] = [];
  let total = 0;
  if (matches === undefined && view.indices === undefined) {
    total = rows.length;
    const end = Math.min(rows.length, view.offset + view.limit);
    for (let index = Math.min(view.offset, rows.length); index < end; index++)
      items.push(selectRowFields(rows[index]!, index, fields));
    return { items, total };
  }
  for (const index of rowIndices(rows.length, view.indices)) {
    const row = rows[index]!;
    if (matches !== undefined && !matches(row, index)) continue;
    if (total >= view.offset && items.length < view.limit)
      items.push(selectRowFields(row, index, fields));
    total++;
  }
  return { items, total };
};
