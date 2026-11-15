/** Doctor's id for the desktop build host scope. */
export const DESKTOP_BUILD_PROVIDER_ID = "desktop_build";

/** Deep-analysis providers and the desktop build host, whose readiness doctor can select explicitly. */
export const DOCTOR_PROVIDER_IDS = [
  "hopper",
  "ghidra",
  "ida",
  "jadx",
  "kuna",
  DESKTOP_BUILD_PROVIDER_ID,
] as const;

/** A provider id `rea doctor --provider` accepts. */
export type DoctorProviderId = (typeof DOCTOR_PROVIDER_IDS)[number];

const DOCTOR_PROVIDER_ID_SET: ReadonlySet<string> = new Set(
  DOCTOR_PROVIDER_IDS,
);

/** Whether `rea doctor --provider` can check this provider's readiness. */
export const isDoctorProviderId = (
  providerId: string,
): providerId is DoctorProviderId => DOCTOR_PROVIDER_ID_SET.has(providerId);

/** Whether a check belongs to the desktop build scope, which decides only its own health. */
export const isDesktopBuildCheck = (name: string): boolean =>
  name.startsWith(`${DESKTOP_BUILD_PROVIDER_ID}-`);
