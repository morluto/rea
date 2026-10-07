/** Ghidra build whose bridge behavior this REA release verifies. */
export const SUPPORTED_GHIDRA_VERSION = "12.1.4";
/**
 * JDK major used when an installation omits `application.java.min`.
 * Admission uses that installation's `application.java.min` and
 * `application.java.max`. An empty maximum means the release sets no upper bound.
 */
export const SUPPORTED_GHIDRA_JAVA_MAJOR = 21;

/** Numeric Ghidra release read from `application.version`. */
interface GhidraReleaseVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** How an observed Ghidra release relates to this adapter's bridge. */
type GhidraReleaseCompatibility =
  | {
      readonly status: "verified";
      readonly version: GhidraReleaseVersion;
      readonly raw: string;
    }
  | {
      readonly status: "compatible";
      readonly version: GhidraReleaseVersion;
      readonly raw: string;
    }
  | {
      readonly status: "unsupported";
      readonly version: GhidraReleaseVersion;
      readonly raw: string;
    }
  | { readonly status: "unresolved"; readonly raw: string | null };

/** One Java major bound declared by `application.properties`. */
type GhidraJavaBound =
  | { readonly status: "absent" }
  | { readonly status: "major"; readonly major: number }
  | { readonly status: "unresolved"; readonly raw: string };

/** JDK majors this installation admits, after reading its own properties. */
export interface GhidraJavaRequirement {
  readonly minimumMajor: number;
  readonly maximumMajor: number | null;
  readonly unresolved: string | null;
}

/** Version and Java bounds read from one `application.properties` file. */
export interface GhidraApplicationProperties {
  readonly providerVersion: string | null;
  readonly javaMinimum: GhidraJavaBound;
  readonly javaMaximum: GhidraJavaBound;
}

const GHIDRA_RELEASE_PATTERN = /^(\d+)\.(\d+)(?:\.(\d+))?([-+].*)?$/u;
const JAVA_MAJOR_PATTERN = /^(\d+)(?:\.\d+)*$/u;

/** Read the version and Java bounds Ghidra publishes for one installation. */
export const ghidraApplicationProperties = (
  content: string,
): GhidraApplicationProperties => ({
  providerVersion: propertyValue(content, "application.version"),
  javaMinimum: parseJavaBound(propertyValue(content, "application.java.min")),
  javaMaximum: parseJavaBound(propertyValue(content, "application.java.max")),
});

/** Classify `application.version` against the verified release line. */
export const ghidraReleaseCompatibility = (
  raw: string | null | undefined,
): GhidraReleaseCompatibility => {
  if (raw === null || raw === undefined)
    return { status: "unresolved", raw: null };
  const version = parseGhidraRelease(raw);
  if (version === undefined) return { status: "unresolved", raw };
  if (raw === SUPPORTED_GHIDRA_VERSION)
    return { status: "verified", version, raw };
  const verified = verifiedGhidraRelease();
  return version.major === verified.major && version.minor === verified.minor
    ? { status: "compatible", version, raw }
    : { status: "unsupported", version, raw };
};

/**
 * Limitation recorded when a session runs a compatible build other than the
 * verified release. The observed version stays on the provider identity.
 */
export const unverifiedGhidraBuildLimitation = (
  providerVersion: string,
): string | undefined => {
  const compatibility = ghidraReleaseCompatibility(providerVersion);
  if (compatibility.status !== "compatible") return undefined;
  return `This session uses Ghidra ${providerVersion}. The bridge is verified against ${SUPPORTED_GHIDRA_VERSION}; other ${ghidraReleaseLine()} builds are accepted and the observed version is reported.`;
};

/** Release line accepted by this bridge, such as `12.1.x`. */
export const ghidraReleaseLine = (): string => {
  const verified = verifiedGhidraRelease();
  return `${String(verified.major)}.${String(verified.minor)}.x`;
};

/** Detail for the installation version check, including the accepted line. */
export const ghidraVersionDetail = (raw: string | null | undefined): string => {
  const compatibility = ghidraReleaseCompatibility(raw);
  switch (compatibility.status) {
    case "unresolved":
      return compatibility.raw ?? "unknown";
    case "verified":
      return compatibility.raw;
    case "compatible":
      return `${compatibility.raw}; compatible ${ghidraReleaseLine()} release (verified build ${SUPPORTED_GHIDRA_VERSION})`;
    case "unsupported":
      return `${compatibility.raw}; accepted releases are ${ghidraReleaseLine()} (verified build ${SUPPORTED_GHIDRA_VERSION})`;
    default: {
      const unreachable: never = compatibility;
      return unreachable;
    }
  }
};

/** Whether this release line can run the packaged bridge. */
export const ghidraReleaseAccepted = (
  raw: string | null | undefined,
): boolean => {
  const status = ghidraReleaseCompatibility(raw).status;
  return status === "verified" || status === "compatible";
};

/** Resolve JDK majors from `application.java.min` and `application.java.max`. */
export const ghidraJavaRequirement = (
  properties: GhidraApplicationProperties | undefined,
): GhidraJavaRequirement => {
  const minimum = properties?.javaMinimum ?? { status: "absent" };
  const maximum = properties?.javaMaximum ?? { status: "absent" };
  if (minimum.status === "unresolved")
    return unresolvedJavaRequirement(`application.java.min=${minimum.raw}`);
  if (maximum.status === "unresolved")
    return unresolvedJavaRequirement(`application.java.max=${maximum.raw}`);
  const minimumMajor =
    minimum.status === "major" ? minimum.major : SUPPORTED_GHIDRA_JAVA_MAJOR;
  const maximumMajor = maximum.status === "major" ? maximum.major : null;
  if (maximumMajor !== null && maximumMajor < minimumMajor)
    return unresolvedJavaRequirement(
      `application.java.max=${String(maximumMajor)} is below application.java.min=${String(minimumMajor)}`,
    );
  return { minimumMajor, maximumMajor, unresolved: null };
};

/** Caller-facing description of one resolved or unreadable JDK range. */
export const ghidraJavaRangeLabel = (
  requirement: GhidraJavaRequirement,
): string => {
  if (requirement.unresolved !== null)
    return "a 64-bit full JDK matching the installation's declared Java bounds";
  if (requirement.maximumMajor === null)
    return `a 64-bit full JDK ${String(requirement.minimumMajor)} or newer`;
  if (requirement.maximumMajor === requirement.minimumMajor)
    return `a 64-bit full JDK ${String(requirement.minimumMajor)}`;
  return `a 64-bit full JDK ${String(requirement.minimumMajor)} through ${String(requirement.maximumMajor)}`;
};

/** Whether an observed JDK satisfies the installation's declared range. */
export const ghidraJavaMajorAccepted = (
  major: number,
  requirement: GhidraJavaRequirement,
): boolean =>
  requirement.unresolved === null &&
  major >= requirement.minimumMajor &&
  (requirement.maximumMajor === null || major <= requirement.maximumMajor);

const verifiedGhidraRelease = (): GhidraReleaseVersion => {
  const version = parseGhidraRelease(SUPPORTED_GHIDRA_VERSION);
  if (version === undefined)
    throw new TypeError(
      `SUPPORTED_GHIDRA_VERSION ${SUPPORTED_GHIDRA_VERSION} is not a Ghidra release`,
    );
  return version;
};

const parseGhidraRelease = (raw: string): GhidraReleaseVersion | undefined => {
  const match = GHIDRA_RELEASE_PATTERN.exec(raw);
  const major = integerGroup(match?.[1]);
  const minor = integerGroup(match?.[2]);
  if (match === null || major === undefined || minor === undefined)
    return undefined;
  const patch = match[3] === undefined ? 0 : integerGroup(match[3]);
  return patch === undefined ? undefined : { major, minor, patch };
};

const parseJavaBound = (raw: string | null): GhidraJavaBound => {
  if (raw === null) return { status: "absent" };
  const major = integerGroup(JAVA_MAJOR_PATTERN.exec(raw)?.[1]);
  return major === undefined
    ? { status: "unresolved", raw }
    : { status: "major", major };
};

const integerGroup = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const unresolvedJavaRequirement = (
  unresolved: string,
): GhidraJavaRequirement => ({
  minimumMajor: SUPPORTED_GHIDRA_JAVA_MAJOR,
  maximumMajor: null,
  unresolved,
});

const propertyValue = (content: string, name: string): string | null => {
  for (const line of content.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator < 0 || line.slice(0, separator).trim() !== name) continue;
    const value = line.slice(separator + 1).trim();
    return value.length === 0 ? null : value;
  }
  return null;
};
