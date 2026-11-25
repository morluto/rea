/**
 * Compare observed per-file counts with a counted baseline. A file may not
 * exceed its recorded count. A count below the baseline is stale; with
 * `shrink`, the returned baseline lowers it (and drops zero entries) but never
 * raises any count; `lowered` says whether it did, so callers rewrite a
 * baseline only when it changed.
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
  if (!shrink || stale.length === 0)
    return { grown, stale, baseline, lowered: false };
  const shrunk = { ...baseline };
  for (const { path, count } of stale)
    if (count === 0) delete shrunk[path];
    else shrunk[path] = count;
  return { grown, stale: [], baseline: shrunk, lowered: true };
};

/**
 * Record a comparison's lowered baseline under `key` in the full baseline
 * map. Returns whether the map changed, so the caller rewrites the file only
 * then. A key whose last count was removed is deleted rather than kept empty.
 */
export const recordLoweredBaseline = (baselines, key, compared) => {
  if (!compared.lowered) return false;
  if (Object.keys(compared.baseline).length === 0) delete baselines[key];
  else baselines[key] = compared.baseline;
  return true;
};

const byCodeUnit = ([left], [right]) =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * One guard's baseline file in its one written form: paths sorted by code
 * unit. Each guard has its own file, so changes to different guards never
 * touch the same file. The guard rejects a file in any other form, so a hand
 * edit or merge cannot leave an order the next `--shrink-baselines` would
 * silently rewrite in an unrelated change.
 */
export const serializeCountedBaseline = (counts) =>
  `${JSON.stringify(
    Object.fromEntries(Object.entries(counts).sort(byCodeUnit)),
    null,
    2,
  )}\n`;

/**
 * What the guard does with one guard's baseline file, read as `text`
 * (`undefined` when there is none), given that guard's counts after comparison
 * (`undefined` or empty when it has none left): nothing when the file is
 * already in its written form or absent with no counts; otherwise, when
 * shrinking, `write` that form (even if no count was lowered) or `delete` a
 * file with no counts left; without shrinking, `reject` the file so a hand
 * edit is fixed in its own change.
 */
export const reconcileBaselineFile = (text, counts, shrink) => {
  if (counts === undefined || Object.keys(counts).length === 0) {
    if (text === undefined) return { action: "none" };
    return shrink ? { action: "delete" } : { action: "reject" };
  }
  const written = serializeCountedBaseline(counts);
  if (written === text) return { action: "none" };
  return shrink ? { action: "write", text: written } : { action: "reject" };
};
