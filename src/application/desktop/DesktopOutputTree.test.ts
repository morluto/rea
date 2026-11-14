import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { planOutputTree, writeOutputTree } from "./DesktopOutputTree.js";

it("does not create output parents or invoke the writer after cancellation", async () => {
  const root = await createTestTempDirectory("rea-output-cancel-");
  const directory = join(root, "new-parent", "output");
  const refusal = {
    operation: "export_desktop_application",
    field: "directory",
  };
  const plan = await planOutputTree(directory, refusal);
  const controller = new AbortController();
  const reason = new Error("cancelled before output acquisition");
  controller.abort(reason);
  let written = false;
  const failure = await writeOutputTree(
    plan,
    async () => {
      written = true;
    },
    refusal,
    controller.signal,
  ).catch((cause: unknown) => cause);
  expect(written).toBe(false);
  expect(await readdir(root)).toEqual([]);
  expect(failure).toBeInstanceOf(AnalysisCancelledError);
  expect(failure).toMatchObject({
    operation: refusal.operation,
    cause: reason,
  });
});
