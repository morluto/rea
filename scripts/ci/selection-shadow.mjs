/** Compare the pre-test prediction with the files present in the merged report. */
export function compareSelectionShadow(prediction, sha, expected, observed) {
  if (!sha || prediction?.version !== 1 || prediction.sha !== sha)
    throw new Error(
      "Test selection prediction does not match the checked-out revision",
    );
  const inventory = new Set(expected);
  const paths = prediction.files;
  if (
    !Array.isArray(paths) ||
    !paths.length ||
    !paths.every((path) => inventory.has(path))
  )
    throw new Error("Invalid predicted test inventory");
  const candidates = new Set(paths);
  const reported = new Set(observed.map(({ name }) => name));
  if (candidates.size !== paths.length || reported.size !== observed.length)
    throw new Error("Duplicate test module in prediction or report");
  const failed = observed
    .filter(({ state }) => state === "failed")
    .map(({ name }) => name)
    .sort();
  const matched = observed.filter(({ name }) => candidates.has(name));
  const duration = (files) =>
    Math.round(files.reduce((sum, file) => sum + file.durationMs, 0));
  return {
    version: 1,
    sha,
    candidates: candidates.size,
    observedCandidates: matched.length,
    reportedFiles: reported.size,
    completeInventory:
      reported.size === inventory.size &&
      expected.every((path) => reported.has(path)),
    capturedFailures: failed.filter((name) => candidates.has(name)),
    missedFailures: failed.filter((name) => !candidates.has(name)),
    candidateReportedDurationMs: duration(matched),
    totalReportedDurationMs: duration(observed),
  };
}
