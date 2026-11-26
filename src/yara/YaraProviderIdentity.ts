/** Caller-selected yara command; its implementation and version are not observed. */
export const YARA_PROVIDER_IDENTITY = {
  id: "yara.command",
  name: "yara command",
  version: null,
} as const;

/** The launch setting that selects the yara executable. */
export const YARA_COMMAND_SETTING = "REA_YARA_COMMAND";

/** How a caller repairs a yara command that cannot be started. */
export const YARA_COMMAND_REMEDIATION =
  "Install YARA 4.x, then make the yara command available on PATH or set REA_YARA_COMMAND to its executable. REA does not install yara or download rules. Other tools remain available.";
