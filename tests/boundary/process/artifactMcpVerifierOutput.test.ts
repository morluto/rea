import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { z } from "zod";

import { createVerifierCommands } from "../../../scripts/lib/verify-commands.mjs";
import { withVerifierCleanup } from "../../../scripts/lib/verifier-cleanup.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const observationSchema = z.strictObject({
  accepted: z.boolean(),
  catalogRequests: z.number().int().nonnegative(),
  corruptedReplies: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  toolTimeouts: z.array(z.number().nullable()),
  error: z
    .strictObject({
      name: z.string(),
      message: z.string(),
      code: z.union([z.number(), z.string()]).nullable(),
    })
    .nullable(),
});

async function probe(mode: string) {
  const root = await createTestTempDirectory("rea-artifact-mcp-schema-");
  const target = join(root, "Fixture with spaces 雨.app");
  await mkdir(join(target, "Contents", "Resources"), { recursive: true });
  await writeFile(
    join(target, "Contents", "Info.plist"),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.rea.schema-probe</string></dict></plist>',
  );
  const owner = await createVerifierCommands();
  const { stdout } = await withVerifierCleanup(
    () =>
      owner.exec(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              "../../fixtures/artifactMcpVerifierProbe.mjs",
              import.meta.url,
            ),
          ),
          mode,
          target,
        ],
        { timeout: 25_000 },
      ),
    [() => owner.close()],
  );
  return observationSchema.parse(JSON.parse(stdout));
}

it("rejects a corrupted canonical path in a real resource admission reply", async () => {
  const result = await probe("corrupt");
  expect(result.accepted).toBe(false);
  expect(result.catalogRequests).toBe(1);
  expect(result.corruptedReplies).toBe(1);
  expect(result.error).toMatchObject({
    name: "ProtocolError",
    code: -32602,
    message: expect.stringMatching(/output schema.*canonical_path/u),
  });
});

it("shares cold and warm bindings, forwards the timeout and rebinds after reconnect", async () => {
  const result = await probe("reconnect");
  expect(result).toMatchObject({
    accepted: true,
    catalogRequests: 2,
    toolCalls: 4,
    error: null,
  });
  expect(result.toolTimeouts.filter((timeout) => timeout !== null)).toEqual([
    12_345,
  ]);
});

it("rejects a supplied schema override before dispatching that call", async () => {
  const result = await probe("override");
  expect(result.accepted).toBe(false);
  expect(result.toolCalls).toBe(1);
  expect(result.error?.message).toMatch(/owns the advertised schema/u);
});

it.each(["duplicate-first", "duplicate-last"])(
  "rejects ambiguous named schemas independently of catalog order: %s",
  async (mode) => {
    const result = await probe(mode);
    expect(result.accepted).toBe(false);
    expect(result.toolCalls).toBe(0);
    expect(result.error?.message).toMatch(/Duplicate MCP tool/u);
  },
);

it("preserves cancellation received during final transport cleanup", async () => {
  const result = await probe("cancel-finalization");
  expect(result.accepted).toBe(false);
  expect(result.error?.message).toBe("cancelled during final cleanup");
});

it("retains a work failure when cancellation arrives during cleanup", async () => {
  const result = await probe("failure-cancel-finalization");
  expect(result.accepted).toBe(false);
  expect(result.error?.message).toBe("work failed before cancellation");
});
