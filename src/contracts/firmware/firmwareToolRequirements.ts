import type { FirmwareOperation } from "../../domain/firmware/firmwareAnalysis.js";

/** Derive public support facts from one audited, stable release number. */
const defineToolRequirement = (release: {
  readonly name: string;
  readonly commandEnvironment: string;
  readonly version: readonly [number, number, number];
  readonly revision: string;
  readonly repository: string;
  readonly versionPrefix: string;
}) => {
  const [major, minor, patch] = release.version;
  const version = `${major}.${minor}.${patch}`;
  const line = `${major}.${minor}.x`;
  return {
    ...release,
    version,
    major,
    minor,
    line,
    requirement: `${release.name} ${line} (verified with ${version})`,
  } as const;
};

/** Audited report compatibility; installed tool identity is observed separately. */
export const FIRMWARE_TOOL_REQUIREMENTS = {
  binwalk: defineToolRequirement({
    name: "Binwalk",
    commandEnvironment: "REA_BINWALK_COMMAND",
    version: [4, 0, 0],
    revision: "368c3815cb97976ae7ba6092f356933169f06dae",
    repository: "https://github.com/binwalk-ng/binwalk-ng",
    versionPrefix: "binwalk-ng ",
  }),
  unblob: defineToolRequirement({
    name: "Unblob",
    commandEnvironment: "REA_UNBLOB_COMMAND",
    version: [26, 6, 4],
    revision: "1fcc7a0a584a70a96c31f5a276c20944d199a089",
    repository: "https://github.com/onekey-sec/unblob",
    versionPrefix: "",
  }),
} as const;

/** Caller-supplied firmware engine selected by the operation. */
export type FirmwareEngineName = keyof typeof FIRMWARE_TOOL_REQUIREMENTS;

/** The engine required by each existing firmware operation, shared by discovery and execution. */
export const FIRMWARE_OPERATION_ENGINES = {
  inspect_firmware_regions: "binwalk",
  extract_firmware: "unblob",
} as const satisfies Readonly<Record<FirmwareOperation, FirmwareEngineName>>;
