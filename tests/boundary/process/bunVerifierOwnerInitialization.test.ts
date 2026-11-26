import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each([
  ["initialization failure", "init", true],
  ["initialization and root cleanup failures", "init_close", false],
  ["command failure", "run", true],
  ["command cleanup failure", "close", false],
] as const)(
  "retains the verifier root correctly after %s",
  async (_name, failure, rootClosed) => {
    const root = await createTestTempDirectory("rea-bun-owner-test-");
    await mkdir(join(root, "scripts", "lib"), { recursive: true });
    // VerifierFixture loads src/process/PrivateRuntimeRoot.ts beside its
    // copied scripts/lib, so the stand-in root sits there.
    await mkdir(join(root, "src", "process"), { recursive: true });
    await mkdir(join(root, "dist", "domain"), { recursive: true });
    await writeFile(
      join(root, "scripts", "verify-bun-standalone.mjs"),
      await readFile(
        new URL("../../../scripts/verify-bun-standalone.mjs", import.meta.url),
      ),
    );
    for (const helper of [
      "verifier-cleanup.mjs",
      "verifier-fixture.mjs",
      "canonical-temporary-directory.mjs",
      "verifier-source-loader.mjs",
    ])
      await writeFile(
        join(root, "scripts", "lib", helper),
        await readFile(
          new URL(`../../../scripts/lib/${helper}`, import.meta.url),
        ),
      );
    await writeFile(
      join(root, "scripts", "lib", "verify-commands.mjs"),
      `export async function createVerifierCommands() {
      if (process.env.FAULT.startsWith("init")) throw new Error("owner load refused");
      return { async exec() { throw new Error("command refused"); }, async close() {
        if (process.env.FAULT === "close") throw new Error("owner close refused");
      } };
    }`,
    );
    await writeFile(
      join(root, "src", "process", "PrivateRuntimeRoot.ts"),
      `import { writeFile } from "node:fs/promises";
      export class PrivateRuntimeRoot { static async create() { return {
        path: process.env.ROOT, async close() { if (process.env.FAULT === "init_close") throw new Error("root close refused"); await writeFile(process.env.CLOSED, "closed"); }
      }; } }`,
    );
    await writeFile(
      join(root, "dist", "domain", "evidence.js"),
      `export function parseEvidence() { throw new Error("unexpected"); }`,
    );
    const marker = join(root, "closed");
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts", "verify-bun-standalone.mjs")],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, ROOT: root, CLOSED: marker, FAULT: failure },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      failure.startsWith("init") ? "owner load refused" : "command refused",
    );
    if (failure === "close")
      expect(result.stderr).toContain("owner close refused");
    if (failure === "init_close")
      expect(result.stderr).toContain("root close refused");
    expect(await readFile(marker, "utf8").catch(() => null)).toBe(
      rootClosed ? "closed" : null,
    );
  },
);
