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
 * The baseline file's one written form: guard keys keep their order and each
 * guard's paths are sorted by code unit. The guard rejects a file in any other
 * form, so a hand edit or merge cannot leave an order the next
 * `--shrink-baselines` would silently rewrite in an unrelated change.
 */
export const serializeCountedBaselines = (baselines) =>
  `${JSON.stringify(
    Object.fromEntries(
      Object.entries(baselines).map(([key, counts]) => [
        key,
        Object.fromEntries(Object.entries(counts).sort(byCodeUnit)),
      ]),
    ),
    null,
    2,
  )}\n`;

/**
 * What the guard does with the baseline file it read as `text`, given the
 * baselines after comparison: nothing when the file is already in its written
 * form; otherwise `write` that form when shrinking (even if no count was
 * lowered), or `reject` the file so a hand edit is fixed in its own change.
 */
export const reconcileBaselineFile = (text, baselines, shrink) => {
  const written = serializeCountedBaselines(baselines);
  if (written === text) return { action: "none" };
  return shrink ? { action: "write", text: written } : { action: "reject" };
};
