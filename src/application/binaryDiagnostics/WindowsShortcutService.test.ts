import { parseEvidence } from "../../domain/evidence.js";
import { expect, it } from "vitest";
import { WindowsShortcutService } from "./WindowsShortcutService.js";
import { WINDOWS_SHORTCUT_PROVIDER } from "../../domain/investigationProviders.js";
import { createHash } from "node:crypto";
import { inspectWindowsShortcutInputSchema } from "../../domain/native/windowsShortcut.js";
import { parseWindowsShortcut } from "../../native/windows/WindowsShortcutParser.js";
import { ok } from "../../domain/result.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";

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

it("rejects a relative path and extra arguments before reading", async () => {
  let calls = 0;
  const service = new WindowsShortcutService({
    identity,
    inspect: () => {
      calls += 1;
      return Promise.resolve(ok(report));
    },
  });
  const relative = await service.inspect({ path: "shortcut.lnk" });
  const extra = await service.inspect({
    path: report.artifact.path,
    extra: true,
  });
  expect(relative.ok).toBe(false);
  expect(extra.ok).toBe(false);
  if (!relative.ok) expect(relative.error).toBeInstanceOf(AnalysisInputError);
  if (!extra.ok) expect(extra.error).toBeInstanceOf(AnalysisInputError);
  expect(calls).toBe(0);
});

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

const payload = Buffer.from("PK\u0003\u0004appended-payload", "latin1");
const appendedBytes = Buffer.concat([bytes, payload]);
const appended = await parseWindowsShortcut(
  appendedBytes,
  {
    path,
    sha256: createHash("sha256").update(appendedBytes).digest("hex"),
    bytes: appendedBytes.length,
  },
  inspectWindowsShortcutInputSchema.parse({ path }),
);

it("locates the bytes appended after the ExtraData TerminalBlock", async () => {
  const result = await new WindowsShortcutService({
    identity,
    inspect: () => Promise.resolve(ok(appended)),
  }).inspect({ path: report.artifact.path });
  if (!result.ok) throw result.error;
  expect(appended.extra_data.trailing_bytes).toBeGreaterThan(0);
  expect(result.value.locations).toContainEqual({
    kind: "file-offset-range",
    start: (appended.extra_data.terminal_offset ?? 0) + 4,
    end: appended.artifact.bytes,
  });
});

it("rejects an appended-byte count that does not reach the end of the file", async () => {
  const result = await new WindowsShortcutService({
    identity,
    inspect: () =>
      Promise.resolve(
        ok({
          ...appended,
          extra_data: { ...appended.extra_data, trailing_bytes: 1 },
        }),
      ),
  }).inspect({ path: report.artifact.path });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("rejects a zero appended-byte count when the TerminalBlock does not end the file", async () => {
  const result = await new WindowsShortcutService({
    identity,
    inspect: () =>
      Promise.resolve(
        ok({
          ...appended,
          extra_data: { ...appended.extra_data, trailing_bytes: 0 },
        }),
      ),
  }).inspect({ path: report.artifact.path });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("rejects an appended-byte count whose issue is not recorded", async () => {
  const result = await new WindowsShortcutService({
    identity,
    inspect: () =>
      Promise.resolve(
        ok({
          ...appended,
          issues: appended.issues.map((issue) => ({
            ...issue,
            code: "malformed_structure" as const,
          })),
        }),
      ),
  }).inspect({ path: report.artifact.path });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("retains a completed observation when the caller cancels as the provider completes", async () => {
  const controller = new AbortController();
  const reason = { request: "late WindowsShortcut cancellation" };
  const service = new WindowsShortcutService({
    identity,
    inspect: () => {
      controller.abort(reason);
      return Promise.resolve(ok(report));
    },
  });
  const result = await service.inspect(
    { path: report.artifact.path },
    { signal: controller.signal },
  );
  if (result.ok) throw new Error("Expected late cancellation");
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(reason);
  expect(parseEvidence(result.error.partialObservation)).toMatchObject({
    operation: "inspect_windows_shortcut",
    normalized_result: report,
  });
});
