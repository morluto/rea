/** Host controls that cannot also be supplied as bundle settings. */
export const BUILD_COMPUTER_SETTINGS = [
  "REA_AGENT_ENV_COMMAND",
  "REA_DOCKER_COMMAND",
  "REA_BUILD_COMPUTER_REA_ARCHIVE",
] as const;

/** Bundle variable names, excluding the host controls, in the advertised schema too. */
export const BUNDLE_SETTING_VARIABLE = new RegExp(
  `^(?!(?:${BUILD_COMPUTER_SETTINGS.join("|")})$)REA_[A-Z0-9_]{1,60}$`,
  "u",
);
