import { expectInvalidInspectionInputs } from "../../../tests/support/expectInvalidInspectionInputs.js";
import { lateCancellationEvidence } from "../../../tests/support/lateCancellationEvidence.js";
import { expect, it } from "vitest";
import { WindowsShortcutService } from "./WindowsShortcutService.js";
import { WINDOWS_SHORTCUT_PROVIDER } from "../../domain/investigationProviders.js";
import { createHash } from "node:crypto";
import { inspectWindowsShortcutInputSchema } from "../../domain/native/windowsShortcut.js";
import { parseWindowsShortcut } from "../../native/windows/WindowsShortcutParser.js";
import { ok } from "../../domain/result.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";

const identity = WINDOWS_SHORTCUT_PROVIDER;

const path = "/artifacts/shortcut.lnk";
const bytes = Buffer.alloc(80);
bytes.writeUInt32LE(76, 0);
Buffer.from("0114020000000000c000000000000046", "hex").copy(bytes, 4);
bytes.writeUInt32LE(1, 60);
const report = await parseWindowsShortcut(
  bytes,
  {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  },
  inspectWindowsShortcutInputSchema.parse({ path }),
);

it("rejects a relative path and extra arguments before reading", () =>
  expectInvalidInspectionInputs(
    report,
    "shortcut.lnk",
    (inspect) => new WindowsShortcutService({ identity, inspect }),
  ));

it("records the selected shortcut as a file subject", async () => {
  const result = await new WindowsShortcutService({
    identity,
    inspect: () => Promise.resolve(ok(report)),
  }).inspect({ path: report.artifact.path });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    confidence: "observed",
    subject: { identity: { format: "file" } },
    normalized_result: report,
  });
});

it.each(["examined_id_list_items", "examined_extra_data_blocks"] as const)(
  "rejects contradictory complete %s coverage",
  async (field) => {
    const result = await new WindowsShortcutService({
      identity,
      inspect: () =>
        Promise.resolve(
          ok({
            ...report,
            coverage: { ...report.coverage, [field]: 1 },
          }),
        ),
    }).inspect({ path: report.artifact.path });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
  },
);

it("rejects complete coverage that still lists issues", async () => {
  const result = await new WindowsShortcutService({
    identity,
    inspect: () =>
      Promise.resolve(
        ok({
          ...report,
          issues: [
            {
              code: "truncated",
              offset: 76,
              message: "StringData is truncated",
            },
          ],
        }),
      ),
  }).inspect({ path: report.artifact.path });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("retains a completed observation when the caller cancels as the provider completes", async () => {
  const evidence = await lateCancellationEvidence(
    report,
    "late WindowsShortcut cancellation",
    (inspect) => new WindowsShortcutService({ identity, inspect }),
  );
  expect(evidence).toMatchObject({
    operation: "inspect_windows_shortcut",
    normalized_result: report,
  });
});
