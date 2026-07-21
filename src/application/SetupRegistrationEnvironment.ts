/** Select explicit non-secret permission settings safe for managed MCP registrations. */
export const registrationPermissionEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> => {
  const investigationRoots = environment.REA_INVESTIGATION_INPUT_ROOTS_JSON;
  return investigationRoots === undefined
    ? {}
    : { REA_INVESTIGATION_INPUT_ROOTS_JSON: investigationRoots };
};
