import type { DoctorProviderInspection } from "./Doctor.js";

/** Select explicit non-secret permission settings safe for managed MCP registrations. */
export const registrationPermissionEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> => {
  const investigationRoots = environment.REA_INVESTIGATION_INPUT_ROOTS_JSON;
  return investigationRoots === undefined
    ? {}
    : { REA_INVESTIGATION_INPUT_ROOTS_JSON: investigationRoots };
};

/** Select exact non-secret settings published by available providers. */
export const providerRegistrationEnvironment = (
  inspections: readonly DoctorProviderInspection[],
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    inspections
      .filter(({ available }) => available)
      .flatMap(({ registrationEnvironment }) =>
        Object.entries(registrationEnvironment),
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
