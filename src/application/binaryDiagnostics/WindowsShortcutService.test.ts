import { expect, it } from "vitest";
import { WindowsShortcutService } from "./WindowsShortcutService.js";
import { WINDOWS_SHORTCUT_PROVIDER } from "../../domain/investigationProviders.js";
import type { WindowsShortcut } from "../../domain/native/windowsShortcut.js";
import { ok } from "../../domain/result.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";

const identity = WINDOWS_SHORTCUT_PROVIDER;

const report: WindowsShortcut = {
  artifact: {
    path: "/artifacts/shortcut.lnk",
    sha256: "a".repeat(64),
    bytes: 128,
  },
  header: {
    location: { offset: 0, bytes: 76 },
    header_size: 76,
    clsid: "00021401-0000-0000-C000-000000000046",
    link_flags: { raw: 0, decoded: [] },
    file_attributes: { raw: 0, decoded: [] },
    creation_time: { raw: "0", iso8601: null },
    access_time: { raw: "0", iso8601: null },
    write_time: { raw: "0", iso8601: null },
    file_size: 0,
    icon_index: 0,
    show_command: { raw: 1, decoded: "normal" },
    hotkey: {
      raw: 0,
      modifiers: [],
      virtual_key: null,
      virtual_key_name: null,
    },
  },
  id_list: null,
  link_info: null,
  string_data: {
    name: null,
    relative_path: null,
    working_dir: null,
    arguments: null,
    icon_location: null,
  },
  extra_data: { blocks: [], terminal_offset: null },
  observations: [
    { kind: "arguments_present", evidence_kind: "derived", value: false },
    { kind: "argument_length", evidence_kind: "derived", characters: 0 },
    { kind: "target_extension", evidence_kind: "derived", extension: null },
    { kind: "show_command_minimized", evidence_kind: "derived", value: false },
    {
      kind: "icon_location_differs_from_target",
      evidence_kind: "derived",
      value: null,
    },
  ],
  coverage: {
    status: "complete",
    reason: null,
    examined_id_list_items: 0,
    examined_extra_data_blocks: 0,
    failing_offset: null,
  },
  issues: [],
  limitations: [
    "Rows reproduce the selected Shell Link bytes; they do not resolve, open, or execute the link target.",
  ],
};

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
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    confidence: "observed",
    subject: { format: "file" },
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

it("discards an observation if the caller cancels while the provider completes", async () => {
  const controller = new AbortController();
  const service = new WindowsShortcutService({
    identity,
    inspect: () => {
      controller.abort();
      return Promise.resolve(ok(report));
    },
  });
  const result = await service.inspect(
    { path: report.artifact.path },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisCancelledError);
});
