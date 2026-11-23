import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileOutput } from "../../src/process/ExecFileOutput.js";

/** Run Git's fixture and oracle commands without host configuration or hooks. */
export const createReferenceSourceGitFixture = async (
  configuration: string,
) => {
  const hooks = join(configuration, "no-hooks");
  const template = join(configuration, "no-template");
  const config = join(configuration, "gitconfig");
  await Promise.all([mkdir(hooks), mkdir(template), writeFile(config, "")]);
  const environment = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.toUpperCase().startsWith("GIT_"),
      ),
    ),
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: template,
  };
  return (cwd: string, ...args: readonly string[]) =>
    execFileOutput("git", ["-c", `core.hooksPath=${hooks}`, ...args], {
      cwd,
      env: environment,
    });
};
