import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("returns a nonzero exit for a streamed JSON analysis failure", async () => {
  const root = await createTestTempDirectory("rea-cli-js-missing-");
  const result = await new Promise<{ code: number | string; stdout: string }>(
    (resolve, reject) => {
      execFile(
        process.execPath,
        [
          "scripts/rea.mjs",
          "analyze-javascript-application",
          join(root, "missing"),
          "--json",
        ],
        (error, stdout) => {
          if (error !== null && error.code === undefined) {
            reject(error);
            return;
          }
          resolve({ code: error?.code ?? 0, stdout });
        },
      );
    },
  );
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    code: "artifact_operation_failed",
    details: { reason: "io" },
  });
});

it.skipIf(process.platform === "win32")(
  "returns a typed cancelled CLI result and exit 130 after SIGINT",
  async () => {
    const root = await createTestTempDirectory("rea-cli-js-cancellation-");
    await writeFile(join(root, "main.js"), "export const observed = 1;\n");
    const child = spawn(
      process.execPath,
      ["scripts/rea.mjs", "analyze-javascript-application", root, "--json"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    onTestFinished(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
    });
    let stdout = "",
      partial = "",
      requested = false;
    const progressSchema = z.object({
      rea_progress: z.object({ phase: z.string() }),
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      partial += chunk.toString();
      let newline: number;
      while ((newline = partial.indexOf("\n")) >= 0) {
        const line = partial.slice(0, newline);
        partial = partial.slice(newline + 1);
        const parsed = progressSchema.safeParse(JSON.parse(line));
        if (parsed.success && !requested) {
          requested = true;
          child.kill("SIGINT");
        }
      }
    });
    const exited = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    expect(requested).toBe(true);
    expect(exited).toEqual({ code: 130, signal: null });
    expect(JSON.parse(stdout)).toMatchObject({
      code: "cancelled",
      details: { reason: "cancelled" },
    });
  },
);
