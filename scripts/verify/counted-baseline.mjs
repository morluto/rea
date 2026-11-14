/**
 * Compare observed per-file counts with a counted baseline. A file may not
 * exceed its recorded count. A count below the baseline is stale; with
 * `shrink`, the returned baseline lowers it (and drops zero entries) but never
 * raises any count.
 */
export const compareCountedBaseline = (counts, baseline, shrink) => {
  const grown = [];
  const stale = [];
  for (const [path, count] of counts) {
    const allowed = baseline[path] ?? 0;
    if (count > allowed) grown.push({ path, count, allowed });
  }
  for (const [path, allowed] of Object.entries(baseline)) {
    const count = counts.get(path) ?? 0;
    if (count < allowed) stale.push({ path, count, allowed });
  }
  if (!shrink || stale.length === 0) return { grown, stale, baseline };
  const lowered = { ...baseline };
  for (const { path, count } of stale)
    if (count === 0) delete lowered[path];
    else lowered[path] = count;
  return { grown, stale: [], baseline: lowered };
};
