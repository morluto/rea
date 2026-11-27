import { join } from "node:path";

/** Point package verification at the selected fixture home and clear profile overrides. */
export const packageVerifierHomeEnvironment = (home) => ({
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  CLAUDE_CONFIG_DIR: home,
  CODEX_HOME: join(home, ".codex"),
  COPILOT_HOME: join(home, ".copilot"),
  GROK_HOME: join(home, ".grok"),
  SAND_DATA_ROOT: join(home, ".grokbot"),
  OMP_PROFILE: undefined,
  PI_CODING_AGENT_DIR: undefined,
  PI_CONFIG_DIR: undefined,
  PI_PROFILE: undefined,
  XDG_CONFIG_HOME: join(home, ".config"),
});
