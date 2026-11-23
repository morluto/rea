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

/**
 * Open upstream issue #10154 has no fix commit and no milestone. REA
 * reproduced the unrecovered jump table on exact 12.2. Every admitted build
 * keeps the record until a release is known to clear it.
 */
export const GHIDRA_AARCH64_MASKED_BYTE_SWITCH_DEFECT = {
  kind: "known-provider-defect",
  id: "ghidra-10154",
  provider_id: "ghidra",
  release: "12.2",
  status: "open",
  scope: {
    architecture: "aarch64",
    optimization: "-O",
    construct: "switch",
    bound: "and-0xff",
    table: "byte-offset",
    source: "swift-enum",
  },
  effect: "jump-table-unrecovered-function-truncated",
  upstream_issue:
    "https://github.com/NationalSecurityAgency/ghidra/issues/10154",
} as const;

export type GhidraKnownProviderDefect =
  | typeof GHIDRA_CLANG_O0_SWITCH_DEFECT
  | typeof GHIDRA_AARCH64_MASKED_BYTE_SWITCH_DEFECT;

const formatKnownProviderDefect = (
  defect: GhidraKnownProviderDefect,
): string =>
  defect.id === "ghidra-9996"
    ? formatClosedSwitchDefect(defect)
    : formatOpenSwitchDefect(defect);

const formatClosedSwitchDefect = (
  defect: typeof GHIDRA_CLANG_O0_SWITCH_DEFECT,
): string =>
  `Known provider defect ${defect.id} (${defect.effect}): Ghidra ${defect.release} can omit jump-table flow references and emit incorrect decompiler output for ${defect.scope.compiler} ${defect.scope.optimization} ${defect.scope.architecture} switches whose case labels start above zero. Upstream issue ${defect.upstream_issue} is closed by ${defect.fix_commit}, milestone ${defect.fixed_in}, which is not yet released. This limitation is recorded for parsed ${defect.release} releases whose patch is below ${defect.fixed_in}, including a zero patch and a suffix, and clears on ${defect.fixed_in}. REA's verified switch lane compiles with -O2 and does not cover this shape.`;

const formatOpenSwitchDefect = (
  defect: typeof GHIDRA_AARCH64_MASKED_BYTE_SWITCH_DEFECT,
): string =>
  `Known provider defect ${defect.id} (${defect.effect}): Ghidra ${defect.release} leaves an ${defect.scope.architecture} ${defect.scope.construct} unrecovered when it is a ${defect.scope.table} bounded by ${defect.scope.bound}. The function body stops at the indirect branch. Upstream issue ${defect.upstream_issue} is ${defect.status} and names a Swift ${defect.scope.optimization} ${defect.scope.source} switch; it has no fix commit and no milestone. REA reproduced the unrecovered jump table on the exact ${defect.release} build with an AArch64 ELF object of that instruction shape. A compare-bounded byte table still recovers. This record stays on every admitted build until a release is known to clear it.`;

/** Version-catalog limitation text, before Program language and operation scope. */
export const ghidraKnownProviderDefectLimitations = (
  providerVersion: string,
): readonly string[] =>
  ghidraKnownProviderDefects(providerVersion).map(formatKnownProviderDefect);

/**
 * Operations whose output depends on recovered jump-table flow: decompilation,
 * function dossiers (including their value traces), and reference results.
 */
const GHIDRA_SWITCH_FLOW_OPERATIONS: ReadonlySet<string> = new Set([
  "analyze_function",
  "procedure_pseudo_code",
  "procedure_references",
  "xrefs",
]);

/** Defect-record architecture named by one opened Program language id. */
export const ghidraProgramDefectArchitecture = (
  languageId: string | undefined,
): GhidraKnownProviderDefect["scope"]["architecture"] | undefined => {
  if (languageId === undefined) return undefined;
  const [processor, , size] = languageId.split(":");
  // A language id is processor:endian:size:variant. Size distinguishes x86-64
  // from 32-bit and 16-bit x86. Any AARCH64 language is the AArch64 ISA.
  if (processor === undefined || size === undefined || size.length === 0)
    return undefined;
  if (processor === "x86" && size === "64") return "x86-64";
  if (processor === "AARCH64") return "aarch64";
  return undefined;
};

/**
 * Defects that can apply to this Program and operation. Architecture must
 * match the declared scope. Stripped targets usually leave the original
 * compiler unknown, so an x86-64 Program keeps the clang -O0 record without
 * a compiler match. Switch defects attach only to flow-dependent operations.
 */
export const ghidraApplicableKnownProviderDefects = (
  providerVersion: string,
  languageId: string | undefined,
  operation: string,
): readonly GhidraKnownProviderDefect[] => {
  const architecture = ghidraProgramDefectArchitecture(languageId);
  if (architecture === undefined) return [];
  return ghidraKnownProviderDefects(providerVersion).filter(
    (defect) =>
      defect.scope.architecture === architecture &&
      (defect.scope.construct !== "switch" ||
        GHIDRA_SWITCH_FLOW_OPERATIONS.has(operation)),
  );
};

/** Limitation text for defects that apply to this Program and operation. */
export const ghidraApplicableKnownProviderDefectLimitations = (
  providerVersion: string,
  languageId: string | undefined,
  operation: string,
): readonly string[] =>
  ghidraApplicableKnownProviderDefects(
    providerVersion,
    languageId,
    operation,
  ).map(formatKnownProviderDefect);

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

const parsedReleasePrecedes = (
  version: GhidraReleaseVersion,
  boundary: Pick<GhidraReleaseVersion, "major" | "minor" | "patch">,
): boolean =>
  version.major < boundary.major ||
  (version.major === boundary.major && version.minor < boundary.minor) ||
  (version.major === boundary.major &&
    version.minor === boundary.minor &&
    version.patch < boundary.patch);

/**
 * Defects for one observed application version. `ghidra-9996` follows the
 * parsed major, minor, and patch, so `12.2`, `12.2.0`, and `12.2.0-DEV` all
 * carry it and `12.2.1` does not. A suffix does not change the patch.
 * `ghidra-10154` stays on every admitted build until a fix release is known.
 */
export const ghidraKnownProviderDefects = (
  providerVersion: string,
): readonly GhidraKnownProviderDefect[] => {
  const version = parseGhidraRelease(providerVersion);
  if (version === undefined) return [];
  const fix = parseGhidraRelease(GHIDRA_CLANG_O0_SWITCH_DEFECT.fixed_in);
  const defects: GhidraKnownProviderDefect[] = [];
  if (
    fix !== undefined &&
    version.major === 12 &&
    version.minor === 2 &&
    parsedReleasePrecedes(version, fix)
  )
    defects.push(GHIDRA_CLANG_O0_SWITCH_DEFECT);
  if (ghidraReleaseAccepted(providerVersion))
    defects.push(GHIDRA_AARCH64_MASKED_BYTE_SWITCH_DEFECT);
  return defects;
};

const integerGroup = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};
