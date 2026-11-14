import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { skillDestinations } from "../../../src/application/SetupSkill.js";
import {
  SUPPORTED_CLIENT_DEFINITIONS,
  supportedClients,
} from "../../../src/application/SupportedClients.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const sweepEnvironment = (home: string): NodeJS.ProcessEnv => ({
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: join(home, ".config"),
  GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(home, "system.json"),
  GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(home, "defaults.json"),
  // The compiled CLI prepares Darwin ownership helpers; hosts that select a
  // compiler and SDK explicitly must pass both selections through, as the
  // other compiled-CLI lifecycle tests do.
  ...(process.env.SDKROOT === undefined
    ? {}
    : { SDKROOT: process.env.SDKROOT }),
  ...(process.env.REA_DARWIN_SWIFTC_PATH === undefined
    ? {}
    : { REA_DARWIN_SWIFTC_PATH: process.env.REA_DARWIN_SWIFTC_PATH }),
});

// Path resolution must not decide which clients receive lifecycle coverage.
const sweepClientNames = SUPPORTED_CLIENT_DEFINITIONS.filter(
  (client) => client.format !== "unsupported",
).map((client) => client.name);

for (const name of sweepClientNames)
  cliTest(
    `setup, doctor and uninstall stay symmetric for ${name}`,
    async ({ cli }) => {
      // Keep client homes independent: shared configuration paths can let one
      // client's successful setup hide another client's missing registration.
      // cliTest already shares the worker's compiled-CLI cache across cases.
      const home = await createTestTempDirectory("rea-client-lifecycle-");
      const environment = sweepEnvironment(home);
      const run = (arguments_: readonly string[]) =>
        cli.run({
          arguments: arguments_,
          cwd: home,
          environment,
          timeoutMs: 60_000,
        });
      const client = supportedClients(home, process.platform, environment).find(
        (candidate) => candidate.name === name,
      );
      expect(client?.configPathError, name).toBeUndefined();
      if (client?.markerPath === undefined)
        throw new Error(`client ${name} is not sweepable on this platform`);
      await mkdir(client.markerPath, { recursive: true });

      const setupArguments = ["setup", "--client", name, "--yes", "--json"];
      const doctorArguments = ["doctor", "--client", name, "--skill", "--json"];
      const setup = await run(setupArguments);
      expect(setup.exitCode, setup.stderr).toBe(0);
      expect(setup.json).toMatchObject({ status: "ready" });

      const doctor = await run(doctorArguments);
      expect(doctor.exitCode, doctor.stderr).toBe(0);
      expect(doctor.json).toMatchObject({
        healthy: true,
        scope: { mode: "explicit", clients: [name], skill: true },
        identity: {
          skill: { state: "aligned" },
          registrations: expect.arrayContaining([
            expect.objectContaining({
              client: name,
              config_path: client.configPath,
              state: "aligned",
            }),
          ]),
        },
      });

      const configured = await readFile(client.configPath, "utf8");
      const rerun = await run(setupArguments);
      expect(rerun.exitCode, rerun.stderr).toBe(0);
      expect(rerun.json).toMatchObject({ status: "ready", appliedActions: [] });
      expect(await readFile(client.configPath, "utf8")).toBe(configured);

      const destinations = skillDestinations(home, [name], environment);
      expect(destinations.length).toBeGreaterThan(0);
      for (const destination of destinations)
        await writeFile(
          join(destination.path, "user-notes.txt"),
          "keep my notes\n",
        );

      const uninstall = await run(["uninstall", "--json"]);
      expect(uninstall.exitCode, uninstall.stderr).toBe(0);
      expect(uninstall.json).toMatchObject({ status: "complete" });
      // Doctor's parser must establish absence, not merely report an invalid
      // or stale registration (including Hermes' unquoted YAML `rea:` key).
      const postUninstall = await run(doctorArguments);
      expect(postUninstall.exitCode, postUninstall.stderr).toBe(1);
      expect(postUninstall.json).toMatchObject({
        healthy: false,
        identity: {
          registrations: expect.arrayContaining([
            expect.objectContaining({ client: name, state: "missing" }),
          ]),
        },
      });
      for (const destination of destinations) {
        await expect(
          readFile(join(destination.path, "SKILL.md")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(
          await readFile(join(destination.path, "user-notes.txt"), "utf8"),
        ).toBe("keep my notes\n");
      }
    },
  );
