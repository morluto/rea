/** Doctor's id for the desktop build host scope. */
export const DESKTOP_BUILD_PROVIDER_ID = "desktop_build";

/** Analysis integrations and the desktop build host whose readiness doctor can select explicitly. */
export const DOCTOR_PROVIDER_IDS = [
  "hopper",
  "ghidra",
  "ida",
  "jadx",
  "kuna",
  "binwalk",
  "unblob",
  DESKTOP_BUILD_PROVIDER_ID,
] as const;

/** Whether a check belongs to the desktop build scope, which decides only its own health. */
export const isDesktopBuildCheck = (name: string): boolean =>
  name.startsWith(`${DESKTOP_BUILD_PROVIDER_ID}-`);
