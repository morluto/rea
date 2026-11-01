import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { vi } from "vitest";

import type { execFileOutput } from "../../src/process/ExecFileOutput.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

export type ExecFileOutputOptions = NonNullable<
  Parameters<typeof execFileOutput>[2]
>;

/** A selected executable on disk; the injected runner never executes it. */
export const rizinExecutableFixture = async () => {
  const directory = await createTestTempDirectory("rea-rizin-identity-");
  const executable = join(directory, "rizin");
  const path = join(directory, "sample.bin");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(path, "sample");
  const digest = async () =>
    createHash("sha256")
      .update(await readFile(executable))
      .digest("hex");
  return { executable, path, digest };
};

/** A fake runner: `-v` prints the banner, any other command fixed output. */
export const versionProbeRunner = (banner: () => string) =>
  vi.fn(
    async (
      _command: string,
      args: readonly string[],
      _options?: ExecFileOutputOptions,
    ) => ({
      stdout: args[0] === "-v" ? banner() : "command output",
      stderr: "",
    }),
  );

/** The version probes a fake runner has received. */
export const versionProbeCount = (run: ReturnType<typeof versionProbeRunner>) =>
  run.mock.calls.filter(([, args]) => args[0] === "-v").length;
