import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { parseCliJsonInput } from "../../../src/cli/cliJsonInput.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { failFileReadAfterAbort } from "../../support/failFileReadAfterAbort.js";
import { holdFirstFileRead } from "../../support/holdFirstFileRead.js";

it("reports an already-cancelled inline JSON read as cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  expect(
    await parseCliJsonInput('{"value":1}', "test-input", controller.signal),
  ).toMatchObject({
    ok: false,
    error: { code: "cancelled", details: { operation: "test-input" } },
  });
});

it("stops a streamed file read on cancellation and allows the next read", async () => {
  const root = await createTestTempDirectory("rea-json-input-cancel-");
  const path = join(root, "input.json");
  const document = `${" ".repeat(9 * 1024 * 1024)}{"value":1}`;
  await writeFile(path, document);
  const reader = await holdFirstFileRead(path);
  const controller = new AbortController();
  const pending = parseCliJsonInput(path, "test-input", controller.signal);
  try {
    await reader.reached(pending, "first JSON file chunk");
    controller.abort();
    reader.release();
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: "cancelled", details: { operation: "test-input" } },
    });
    expect(reader.totalReadBytes).toBeLessThan(Buffer.byteLength(document));
  } finally {
    controller.abort();
    reader.release();
    await pending.finally(() => vi.restoreAllMocks());
  }
  await writeFile(path, '{"after":true}');
  expect(await parseCliJsonInput(path, "test-input")).toEqual({
    ok: true,
    value: { after: true },
  });
});

it.each([
  { label: "undefined", physical: undefined },
  { label: "null", physical: null },
  {
    label: "streamed undefined",
    physical: undefined,
    padding: 9 * 1024 * 1024,
  },
  { label: "streamed null", physical: null, padding: 9 * 1024 * 1024 },
])(
  "classifies a physical $label read rejection before late cancellation",
  async ({ physical, padding }) => {
    const root = await createTestTempDirectory("rea-json-input-late-io-");
    const path = join(root, "input.json");
    await writeFile(path, `${" ".repeat(padding ?? 0)}{"value":1}`);
    const controller = new AbortController();
    await failFileReadAfterAbort(
      path,
      controller,
      new Error("later cancellation"),
      physical,
    );
    try {
      expect(
        await parseCliJsonInput(path, "test-input", controller.signal),
      ).toMatchObject({
        ok: false,
        error: {
          code: "invalid_request",
          input_reason: "read-failed",
          details: { operation: "test-input" },
        },
      });
    } finally {
      vi.restoreAllMocks();
    }
  },
);

it("keeps a physical rejection when it is the identical object used to abort", async () => {
  const root = await createTestTempDirectory("rea-json-input-identical-abort-");
  const path = join(root, "input.json");
  await writeFile(path, '{"value":1}');
  const controller = new AbortController();
  const physical = Object.assign(new Error("descriptor EIO"), { code: "EIO" });
  await failFileReadAfterAbort(path, controller, physical, physical);
  try {
    expect(
      await parseCliJsonInput(path, "test-input", controller.signal),
    ).toMatchObject({
      ok: false,
      error: {
        code: "invalid_request",
        input_reason: "read-failed",
        details: {
          operation: "test-input",
          issues: [{ message: expect.stringContaining("EIO") }],
        },
      },
    });
  } finally {
    vi.restoreAllMocks();
  }
});

it("cancels cooperative sealing of an owned inline Evidence input", async () => {
  const controller = new AbortController();
  const input = JSON.stringify(
    Array.from({ length: 20000 }, () => ({ value: 1 })),
  );
  const pending = parseCliJsonInput(input, "test-input", controller.signal, {
    snapshot: true,
  });
  controller.abort();
  expect(await pending).toMatchObject({
    ok: false,
    error: { code: "cancelled" },
  });
});
