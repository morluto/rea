import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { XcrunCommandRunner } from "../../../../src/native/CommandRunner.js";
import { ok } from "../../../../src/domain/result.js";

afterEach(() => vi.unstubAllEnvs());

it.skipIf(process.platform === "win32")(
  "executes native commands with the selected environment snapshot instead of ambient values",
  async () => {
    vi.stubEnv("REA_NATIVE_SELECTED", "ambient");
    vi.stubEnv("REA_NATIVE_AMBIENT", "ambient-only");
    const environment = {
      REA_NATIVE_SELECTED: "selected",
      PATH: "/selected-path",
    };
    const runner = new XcrunCommandRunner(environment, async () =>
      ok({ path: process.execPath, sha256: "a".repeat(64) }),
    );
    environment.REA_NATIVE_SELECTED = "mutated-after-construction";
    const captured = await runner.run(
      "file",
      [
        "-e",
        "process.stdout.write(JSON.stringify({selected:process.env.REA_NATIVE_SELECTED,ambient:process.env.REA_NATIVE_AMBIENT??null,path:process.env.PATH,locale:process.env.LC_ALL}))",
      ],
      {},
    );
    if (!captured.ok) throw captured.error;
    expect(JSON.parse(captured.value.stdout)).toEqual({
      selected: "selected",
      ambient: null,
      path: "/selected-path",
      locale: "C",
    });
  },
);

it.skipIf(process.platform === "win32")(
  "does not accept signal termination as an allowed nonzero exit",
  async () => {
    const sha256 = createHash("sha256")
      .update(await readFile(process.execPath))
      .digest("hex");
    const runner = new XcrunCommandRunner({}, async () =>
      ok({ path: process.execPath, sha256 }),
    );
    const exited = await runner.run("file", ["-e", "process.exit(1)"], {
      acceptNonZero: true,
    });
    expect(exited.ok).toBe(true);
    if (exited.ok) expect(exited.value.exitCode).toBe(1);
    const killed = await runner.run(
      "file",
      ["-e", "process.kill(process.pid, 'SIGTERM')"],
      { acceptNonZero: true },
    );
    expect(killed.ok).toBe(false);
    if (!killed.ok) expect(killed.error.reason).toBe("nonzero-exit");
  },
);
