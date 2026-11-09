import { expect, it } from "vitest";
import {
  inspectWindowsShortcutInputSchema,
  windowsShortcutSchema,
} from "./windowsShortcut.js";

const report = {
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
    show_command: { raw: 1, decoded: "normal" as const },
    hotkey: {
      raw: 0,
      modifiers: [] as Array<"shift" | "control" | "alt">,
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
    {
      kind: "arguments_present" as const,
      evidence_kind: "derived" as const,
      value: false,
    },
    {
      kind: "argument_length" as const,
      evidence_kind: "derived" as const,
      characters: 0,
    },
    {
      kind: "target_extension" as const,
      evidence_kind: "derived" as const,
      extension: null,
    },
    {
      kind: "show_command_minimized" as const,
      evidence_kind: "derived" as const,
      value: false,
    },
    {
      kind: "icon_location_differs_from_target" as const,
      evidence_kind: "derived" as const,
      value: null,
    },
  ],
  coverage: {
    status: "complete" as const,
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

it("rejects extra caller arguments and admits an empty shortcut inventory", () => {
  expect(
    inspectWindowsShortcutInputSchema.safeParse({
      path: "/artifacts/shortcut.lnk",
      extra: true,
    }).success,
  ).toBe(false);
  expect(windowsShortcutSchema.parse(report).header.clsid).toBe(
    "00021401-0000-0000-C000-000000000046",
  );
});

it("admits partial coverage with a failing offset", () => {
  expect(
    windowsShortcutSchema.parse({
      ...report,
      coverage: {
        status: "partial",
        reason: "StringData is truncated",
        examined_id_list_items: 0,
        examined_extra_data_blocks: 0,
        failing_offset: 76,
      },
      issues: [
        {
          code: "truncated",
          offset: 76,
          message: "StringData is truncated",
        },
      ],
    }).coverage.failing_offset,
  ).toBe(76);
});
