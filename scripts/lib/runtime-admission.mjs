/**
 * Reject a Node.js release the compiled runtime cannot link against.
 *
 * The dispatcher imports compiled modules before it can report anything, and
 * those modules import Node APIs that some releases do not export. Checking the
 * published range here keeps that failure a readable refusal instead of a
 * module-linking stack trace.
 *
 * `range` is the package's own `engines.node`, so the dispatcher and the
 * installer cannot drift apart. This module deliberately has no imports: the
 * dispatcher must admit the runtime before any dependency, including `semver`,
 * can be resolved.
 */
export const unsupportedRuntimeMessage = (range, version) => {
  if (typeof range !== "string" || range.length === 0) return undefined;
  if (satisfiesRange(range, version)) return undefined;
  return (
    `REA requires ${supportedReleaseProse(range)}; this process runs Node.js ${version}. ` +
    "Install a supported release, then retry."
  );
};

/** Human-readable release families for an `engines.node` range. */
export const supportedReleaseProse = (range) =>
  `Node.js ${range
    .split("||")
    .map((clause) => {
      const floor = /^(\^|>=)\s*(\d+\.\d+\.\d+)$/.exec(clause.trim());
      if (floor === null) return clause.trim();
      return floor[1] === ">="
        ? `${floor[2]}+`
        : `${floor[2].split(".")[0]}.x (>=${floor[2]})`;
    })
    .join(", ")}`;

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const FLOOR = /^(>=|\^)\s*(\d+)\.(\d+)\.(\d+)$/;

/** Every clause of the published range is `^major.minor.patch` or `>=`. */
const satisfiesRange = (range, version) => {
  const found = VERSION.exec(version);
  // A prerelease or a non-release spelling is never an admitted release.
  if (found === null) return false;
  const [, major, minor, patch] = found;
  return range.split("||").some((clause) => {
    const floor = FLOOR.exec(clause.trim());
    if (floor === null) return false;
    const [, operator, floorMajor, floorMinor, floorPatch] = floor;
    if (Number(major) !== Number(floorMajor))
      return operator === ">=" && Number(major) > Number(floorMajor);
    if (minor !== floorMinor) return Number(minor) > Number(floorMinor);
    return Number(patch) >= Number(floorPatch);
  });
};
