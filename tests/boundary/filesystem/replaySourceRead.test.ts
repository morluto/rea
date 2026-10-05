import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { prepareReplayPlan } from "../../../src/application/JavaScriptReplayPlanning.js";
import { controlledReplayInputSchema } from "../../../src/domain/javascriptReplay.js";
import { SystemJavaScriptReplayHost } from "../../../src/replay/SystemJavaScriptReplayHost.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("replay source byte admission", () => {
  it.each([0, 16, 65_537])("reads exactly %i admitted bytes", async (limit) => {
    const root = await createTestTempDirectory("rea-replay-source-");
    const path = join(root, "module.mjs");
    const bytes = Buffer.alloc(limit, 0x61);
    await writeFile(path, bytes);
    expect(
      await new SystemJavaScriptReplayHost().readSource(path, limit),
    ).toEqual({
      canonicalPath: path,
      bytes,
    });
  });

  it("rejects an oversized source and a directory", async () => {
    const root = await createTestTempDirectory("rea-replay-source-");
    const path = join(root, "module.mjs");
    await writeFile(path, "oversized");
    const host = new SystemJavaScriptReplayHost();
    await expect(host.readSource(path, 1)).rejects.toThrow("declared limit");
    await expect(host.readSource(root, 1)).rejects.toThrow();
  });
});

it("rejects a host result larger than the remaining module budget", async () => {
  const path = process.execPath;
  const identity = { path, version: "fixture", sha256: "1".repeat(64) };
  const input = controlledReplayInputSchema.parse({
    mode: "plan",
    left: {
      modules: [
        {
          alias: "entry",
          path,
          format: "esm",
          role: "module",
          dependencies: {},
        },
      ],
      entry_alias: "entry",
      entry_export: "default",
    },
    cases: [{ case_id: "one", arguments: [] }],
    limits: { module_bytes: 16 },
  });
  await expect(
    prepareReplayPlan(
      input,
      {
        nodePath: path,
        bubblewrapPath: path,
        systemdRunPath: path,
        systemctlPath: path,
        shellPath: path,
      },
      {
        readSource: async (canonicalPath, maximumBytes) => ({
          canonicalPath,
          bytes: Buffer.alloc(maximumBytes + 1),
        }),
        identifyExecutable: async () => identity,
        identifyWorker: async () => identity,
        identifyRuntimeClosure: async () => [],
        seccompDigest: () => "2".repeat(64),
        probe: async () => undefined,
      },
    ),
  ).rejects.toThrow("Replay module bytes exceed the aggregate limit");
});
