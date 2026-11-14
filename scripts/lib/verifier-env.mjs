/**
 * The verifier's nested npm invocations must not inherit the caller's ambient
 * npm install-script policy. A user-level npmrc (or an exported shell
 * variable) with `allow-scripts` set makes every project-scoped nested npm
 * call fail with `EALLOWSCRIPTS`, which is not the verifier's intent to
 * honor, or grant. Returns a shallow copy of `environment` with any
 * case-insensitive `npm_config_allow_scripts` key removed; every other entry
 * is preserved verbatim.
 */
export const scrubNpmInstallPolicy = (environment) => {
  const scrubbed = {};
  for (const [key, value] of Object.entries(environment))
    if (key.toLowerCase() !== "npm_config_allow_scripts") scrubbed[key] = value;
  return scrubbed;
};
