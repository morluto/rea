/** Ghidra build whose bridge behavior this REA release verifies. */
export const SUPPORTED_GHIDRA_VERSION = "12.2";
/** Verified JDK major; admission uses the installation's declared bounds. */
export const SUPPORTED_GHIDRA_JAVA_MAJOR = 25;
/**
 * Oldest minor on the verified major that can compile the packaged bridge.
 * Ghidra 12.2 replaced `PrototypeModel.getStorageLocations(Program, DataType[], boolean)`
 * with a four-argument form. 12.1.x has only the three-argument method, so the
 * bridge does not compile there.
 */
export const ADMITTED_GHIDRA_MINOR_FLOOR = 2;

/** Numeric Ghidra release read from `application.version`. */
interface GhidraReleaseVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly suffix: string;
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

const GHIDRA_RELEASE_PATTERN = /^(\d+)\.(\d+)(?:\.(\d+))?([-+].*)?$/u;

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
  // Admit this major from the compile floor upward. The observed version stays
  // on the provider identity, and anything other than the verified build runs
  // with the unverified-build limitation.
  return version.major === verified.major &&
    version.minor >= ADMITTED_GHIDRA_MINOR_FLOOR
    ? { status: "compatible", version, raw }
    : { status: "unsupported", version, raw };
};

/**
 * Exact Ghidra 12.2 PUBLIC build. Closed upstream issue #9996, fixed by
 * `c93917a622211349998f641de54cfdbe0e0e5bee` and scheduled for 12.2.1.
 */
export const GHIDRA_CLANG_O0_SWITCH_DEFECT = {
  kind: "known-provider-defect",
  id: "ghidra-9996",
  provider_id: "ghidra",
  release: "12.2",
  fixed_in: "12.2.1",
  fix_commit: "c93917a622211349998f641de54cfdbe0e0e5bee",
  scope: {
    compiler: "clang",
    architecture: "x86-64",
    optimization: "-O0",
    construct: "switch",
    case_base: "above-zero",
  },
  effect: "jump-table-flow-references-omitted",
  upstream_issue:
    "https://github.com/NationalSecurityAgency/ghidra/issues/9996",
} as const;

export type GhidraKnownProviderDefect = typeof GHIDRA_CLANG_O0_SWITCH_DEFECT;

/** Only the exact 12.2 application version carries the closed #9996 defect. */
export const ghidraKnownProviderDefect = (
  providerVersion: string,
): GhidraKnownProviderDefect | undefined =>
  providerVersion === "12.2" ? GHIDRA_CLANG_O0_SWITCH_DEFECT : undefined;

/** Session and decompile limitation for the exact Ghidra 12.2 switch defect. */
export const ghidraKnownProviderDefectLimitation = (
  providerVersion: string,
): string | undefined => {
  const defect = ghidraKnownProviderDefect(providerVersion);
  if (defect === undefined) return undefined;
  return `Known provider defect ${defect.id}: Ghidra ${defect.release} can omit jump-table flow references and emit incorrect decompiler output for Clang ${defect.scope.optimization} ${defect.scope.architecture} switches whose case labels start above zero. Upstream issue ${defect.upstream_issue} is closed by ${defect.fix_commit}, milestone ${defect.fixed_in}, which is not yet released. This limitation is recorded only for the exact ${defect.release} build and clears on ${defect.fixed_in}. REA's verified switch lane compiles with -O2 and does not cover this shape.`;
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

/** Accepted release floor on this major, such as `12.x (>=12.2)`. */
export const ghidraReleaseLine = (): string => {
  const verified = verifiedGhidraRelease();
  return `${String(verified.major)}.x (>=${String(verified.major)}.${String(ADMITTED_GHIDRA_MINOR_FLOOR)})`;
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

const verifiedGhidraRelease = (): GhidraReleaseVersion => {
  const version = parseGhidraRelease(SUPPORTED_GHIDRA_VERSION);
  if (version === undefined || version.minor < ADMITTED_GHIDRA_MINOR_FLOOR)
    throw new TypeError(
      `SUPPORTED_GHIDRA_VERSION ${SUPPORTED_GHIDRA_VERSION} is not an admitted Ghidra release`,
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
  return patch === undefined
    ? undefined
    : { major, minor, patch, suffix: match[4] ?? "" };
};

/**
 * The version spelling Ghidra's `ApplicationVersion.toString` uses in its
 * settings directory: numeric components normalized, a zero patch and an
 * empty tag omitted. A build-metadata (`+`) suffix has no such spelling.
 */
export const ghidraConfigurationVersion = (raw: string): string | undefined => {
  const version = parseGhidraRelease(raw);
  if (version === undefined || version.suffix.startsWith("+")) return undefined;
  const patch = version.patch === 0 ? "" : `.${String(version.patch)}`;
  const suffix = version.suffix === "-" ? "" : version.suffix;
  return `${String(version.major)}.${String(version.minor)}${patch}${suffix}`;
};

const integerGroup = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};
