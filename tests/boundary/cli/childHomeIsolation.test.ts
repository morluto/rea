import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { selectsChildHome } from "../../support/cli/childHome.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const SETTING = "GHIDRA_INSTALL_DIR";

/** Save one provider setting in the REA configuration under `home`. */
const saveSetting = async (home: string, value: string) => {
  const directory = join(home, ".config", "rea");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "rea.json"),
    JSON.stringify({ [SETTING]: value }),
  );
};

/** The saved value a child reports for the setting, or undefined. */
const savedValue = async (
  cli: TestCli,
  options: {
    readonly freshProcess?: boolean;
    readonly environment?: NodeJS.ProcessEnv;
    /** A home outside the test may hold any configuration, even an invalid one. */
    readonly foreignHome?: boolean;
  } = {},
) => {
  const { foreignHome, ...invocation } = options;
  const result = await cli.run({
    arguments: ["config", "--get", SETTING, "--json"],
    ...invocation,
  });
  if (foreignHome !== true) expect(result.exitCode, result.stderr).toBe(0);
  const reported = result.json as { value?: unknown; source?: unknown };
  return reported.source === "config" ? reported.value : undefined;
};

cliTest(
  "reads saved settings from the file's home in shared and fresh CLI processes",
  async ({ cli, cliHome }) => {
    await saveSetting(cliHome, "/from-owned-home");
    expect(await savedValue(cli)).toBe("/from-owned-home");
    expect(await savedValue(cli, { freshProcess: true })).toBe(
      "/from-owned-home",
    );
  },
);

cliTest.skipIf(process.platform === "win32")(
  "keeps a caller's USERPROFILE-only home instead of adding the file's HOME",
  async ({ cli, cliHome }) => {
    await saveSetting(cliHome, "/from-owned-home");
    const callerHome = await createTestTempDirectory("rea-caller-home-");
    await saveSetting(callerHome, "/from-caller-home");
    for (const freshProcess of [false, true])
      expect(
        await savedValue(cli, {
          freshProcess,
          environment: { USERPROFILE: callerHome },
        }),
      ).toBe("/from-caller-home");
  },
);

cliTest(
  "keeps a caller's empty HOME instead of replacing it with the file's home",
  async ({ cli, cliHome }) => {
    await saveSetting(cliHome, "/from-owned-home");
    for (const freshProcess of [false, true])
      expect(
        await savedValue(cli, {
          freshProcess,
          environment: { HOME: "", USERPROFILE: "" },
          foreignHome: true,
        }),
      ).not.toBe("/from-owned-home");
  },
);

describe("child home selection", () => {
  it.each([
    [undefined, false],
    [{}, false],
    [{ PATH: "/bin" }, false],
    [{ HOME: "/home/caller" }, true],
    [{ USERPROFILE: "C:\\Users\\caller" }, true],
    [{ HOME: "" }, true],
    [{ HOMEDRIVE: "C:", HOMEPATH: "\\Users\\caller" }, true],
    [{ HOME: undefined }, true],
  ] as const)("selects its own home for %j: %s", (environment, selected) => {
    expect(selectsChildHome(environment)).toBe(selected);
  });
});
