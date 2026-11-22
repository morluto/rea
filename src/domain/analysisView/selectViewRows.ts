/** Preserve original indices and count every match while projecting only the requested page. */
export const selectViewRows = <Source, Row>(
  rows: readonly Source[],
  view: { readonly offset: number; readonly limit: number },
  matches: (row: Source, index: number) => boolean,
  project: (row: Source, index: number) => Row,
): { rows: Row[]; total: number } => {
  const selected: Row[] = [];
  let total = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (!matches(row, index)) continue;
    if (total >= view.offset && selected.length < view.limit)
      selected.push(project(row, index));
    total++;
  }
  return { rows: selected, total };
};

/** Select only from an explicit set of candidate indices in ascending order. */
export const selectIndexedViewRows = <Source, Row>(
  rows: readonly Source[],
  candidateIndices: ReadonlySet<number>,
  view: { readonly offset: number; readonly limit: number },
  matches: (row: Source, index: number) => boolean,
  project: (row: Source, index: number) => Row,
): { rows: Row[]; total: number } => {
  const ordered: number[] = [];
  for (const index of candidateIndices) {
    if (Number.isInteger(index) && index >= 0 && index < rows.length)
      ordered.push(index);
  }
  ordered.sort((left, right) => left - right);
  const selected: Row[] = [];
  let total = 0;
  for (let position = 0; position < ordered.length; position += 1) {
    const index = ordered[position]!;
    const row = rows[index]!;
    if (!matches(row, index)) continue;
    if (total >= view.offset && selected.length < view.limit)
      selected.push(project(row, index));
    total++;
  }
  return { rows: selected, total };
};
