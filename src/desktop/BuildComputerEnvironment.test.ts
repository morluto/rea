import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, onTestFinished, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import {
  programOnPath,
  resolveBuildComputerEnvironment,
} from "./BuildComputerEnvironment.js";

const host = async () => {
  const root = await createTestTempDirectory("rea-build-environment-");
  const bin = join(root, "bin");
  const cache = join(root, "cache");
  const archive = join(
    cache,
    "rea/build-computer",
    `rea-${PRODUCT_IDENTITY.packageVersion}.tar.xz`,
  );
  await mkdir(bin);
  await mkdir(join(cache, "rea/build-computer"), { recursive: true });
  for (const program of ["agent-env", "docker"])
    await writeFile(join(bin, program), "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(archive, "packed");
  const environment = {
    HOME: join(root, "home"),
    PATH: `relative-bin:${bin}`,
    XDG_CACHE_HOME: cache,
  };
  return { bin, archive, environment };
};

it.runIf(process.platform === "win32")(
  "skips a Windows PATH entry without a drive, which follows the current drive",
  async () => {
    const root = await createTestTempDirectory("rea-build-program-drive-");
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "agent-env.exe"), "");
    // On the same drive, `\...\bin` names the same existing file.
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    onTestFinished(() => cwd.mockRestore());
    const driveless = bin.slice(2);

    expect(await programOnPath("agent-env", { PATH: driveless })).toBe(
      undefined,
    );
    expect(await programOnPath("agent-env", { PATH: bin })).toBe(
      join(bin, "agent-env.EXE"),
    );
  },
);

it.skipIf(process.platform === "win32")(
  "resolves every build setting on a host that exports none of them",
  async () => {
    const { bin, archive, environment } = await host();

    const resolved = await resolveBuildComputerEnvironment(
      environment,
      "linux",
    );

    expect(resolved).toMatchObject({
      REA_AGENT_ENV_COMMAND: join(bin, "agent-env"),
      REA_DOCKER_COMMAND: join(bin, "docker"),
      REA_BUILD_COMPUTER_REA_ARCHIVE: archive,
    });
  },
);

it.skipIf(process.platform === "win32")(
  "keeps each build setting the environment sets",
  async () => {
    const { environment } = await host();
    const selected = {
      REA_AGENT_ENV_COMMAND: "/opt/agentenv/bin/agent-env",
      REA_DOCKER_COMMAND: "/usr/local/bin/docker",
      REA_BUILD_COMPUTER_REA_ARCHIVE: "/srv/rea-prod.tar.xz",
    };

    expect(
      await resolveBuildComputerEnvironment(
        { ...environment, ...selected },
        "linux",
      ),
    ).toMatchObject(selected);
  },
);

it.skipIf(process.platform === "win32")(
  "looks for defaults only where the caller points",
  async () => {
    const { environment } = await host();
    const empty = await createTestTempDirectory("rea-build-defaults-empty-");

    const resolved = await resolveBuildComputerEnvironment(
      environment,
      "linux",
      { archiveDirectory: empty, searchPath: empty },
    );

    expect(resolved).not.toHaveProperty("REA_AGENT_ENV_COMMAND");
    expect(resolved).not.toHaveProperty("REA_DOCKER_COMMAND");
    expect(resolved).not.toHaveProperty("REA_BUILD_COMPUTER_REA_ARCHIVE");
  },
);
