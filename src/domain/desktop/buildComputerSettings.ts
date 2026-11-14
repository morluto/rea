/** Host controls that cannot also be supplied as bundle settings. */
export const BUILD_COMPUTER_SETTINGS = [
  "REA_AGENT_ENV_COMMAND",
  "REA_DOCKER_COMMAND",
  "REA_BUILD_COMPUTER_REA_ARCHIVE",
] as const;

/** Bundle variable names; schemas advertise the host-control exclusion with `not`. */
export const BUNDLE_SETTING_VARIABLE = /^REA_[A-Z0-9_]{1,60}$/u;

/** Whether a bundle setting name is portable and not a host-control name. */
export const isBundleSettingVariable = (name: string): boolean =>
  BUNDLE_SETTING_VARIABLE.test(name) &&
  !(BUILD_COMPUTER_SETTINGS as readonly string[]).includes(name);
