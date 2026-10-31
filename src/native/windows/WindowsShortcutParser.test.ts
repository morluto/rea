import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  inspectWindowsShortcutInputSchema,
  windowsShortcutSchema,
} from "../../domain/native/windowsShortcut.js";
import {
  ansiShortcut,
  networkShareShortcut,
  powershellHiddenIconSpoofShortcut,
  TRACKER_MAC,
  truncatedStringDataShortcut,
  unknownExtraDataShortcut,
  windowsShortcutBytes,
  wrongClsidShortcut,
} from "../../../tests/fixtures/binaryDiagnostics/windowsShortcut.js";
import { parseWindowsShortcut } from "./WindowsShortcutParser.js";
import {
  WindowsShortcutFormatFailure,
  WindowsShortcutResourceFailure,
} from "./WindowsShortcut.errors.js";

const input = inspectWindowsShortcutInputSchema.parse({
  path: "/artifacts/shortcut.lnk",
});

const artifact = (bytes: Buffer) => ({
  path: "/artifacts/shortcut.lnk",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
});

const parse = (bytes: Buffer, overrides: Partial<typeof input> = {}) =>
  parseWindowsShortcut(bytes, artifact(bytes), { ...input, ...overrides });

it("reads a PowerShell hidden-window shortcut with a spoofed icon", async () => {
  const bytes = powershellHiddenIconSpoofShortcut();
  const report = await parse(bytes);
  expect(windowsShortcutSchema.safeParse(report).success).toBe(true);
  expect(report.header.show_command).toEqual({
    raw: 7,
    decoded: "minimized",
  });
  expect(report.header.creation_time.iso8601).toBe("2024-01-15T12:00:00.000Z");
  expect(report.string_data.arguments?.value).toContain("-WindowStyle Hidden");
  expect(report.string_data.icon_location?.value).toBe(
    "C:\\Windows\\System32\\shell32.dll",
  );
  expect(report.link_info?.local_base_path_unicode).toContain("powershell.exe");
  expect(report.id_list?.items.some((item) => item.kind === "volume")).toBe(
    true,
  );
  expect(report.id_list?.items.some((item) => item.kind === "file_entry")).toBe(
    true,
  );
  expect(report.observations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "arguments_present",
        evidence_kind: "derived",
        value: true,
      }),
      expect.objectContaining({
        kind: "show_command_minimized",
        evidence_kind: "derived",
        value: true,
      }),
      expect.objectContaining({
        kind: "icon_location_differs_from_target",
        evidence_kind: "derived",
        value: true,
      }),
      expect.objectContaining({
        kind: "target_extension",
        evidence_kind: "derived",
        extension: ".exe",
      }),
    ]),
  );
  expect(report.coverage.status).toBe("complete");
});

it("reads network-share LinkInfo names", async () => {
  const report = await parse(networkShareShortcut());
  expect(report.link_info?.common_network_relative_link).toMatchObject({
    net_name_unicode: "\\\\fileserver\\docs",
    device_name_unicode: "Z:",
  });
  expect(report.coverage.status).toBe("complete");
});

it("derives Tracker version-1 MAC and timestamp facts", async () => {
  const report = await parse(
    windowsShortcutBytes({ extraData: [{ kind: "tracker" }] }),
  );
  const tracker = report.extra_data.blocks.find(
    (block) => block.decoded.kind === "tracker",
  );
  expect(tracker?.decoded.kind).toBe("tracker");
  if (tracker?.decoded.kind !== "tracker")
    throw new Error("Expected a TrackerDataBlock");
  expect(tracker.decoded.machine_id).toBe("WORKSTATION");
  const derived = tracker.decoded.droid_uuid_v1[1];
  expect(derived).toMatchObject({
    evidence_kind: "derived",
    version: 1,
    mac: [...TRACKER_MAC]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(":"),
  });
  expect(derived?.timestamp_iso8601).toEqual(expect.stringMatching(/Z$/u));
  expect(report.coverage.status).toBe("complete");
});

it("reads ANSI StringData when IsUnicode is unset", async () => {
  const report = await parse(ansiShortcut());
  expect(report.string_data.name?.encoding).toBe("ansi");
  expect(report.header.link_flags.decoded).not.toContain("IsUnicode");
  expect(report.coverage.status).toBe("complete");
});

it("reports truncated StringData as partial coverage with a failing offset", async () => {
  const report = await parse(truncatedStringDataShortcut());
  expect(report.coverage.status).toBe("partial");
  expect(report.coverage.failing_offset).toEqual(expect.any(Number));
  expect(report.issues.some((issue) => issue.code === "truncated")).toBe(true);
  expect(windowsShortcutSchema.safeParse(report).success).toBe(true);
});

it("lists an unknown ExtraData signature instead of dropping it", async () => {
  const report = await parse(unknownExtraDataShortcut());
  expect(report.extra_data.blocks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        signature: 0xa0ffffff,
        signature_name: null,
        decoded: expect.objectContaining({ kind: "raw" }),
      }),
    ]),
  );
  expect(report.coverage.status).toBe("complete");
});

it("rejects a Shell Link whose CLSID is not the documented value", async () => {
  await expect(parse(wrongClsidShortcut())).rejects.toBeInstanceOf(
    WindowsShortcutFormatFailure,
  );
});

it("rejects a HeaderSize other than 0x4C", async () => {
  await expect(
    parse(windowsShortcutBytes({ headerSize: 0x50, extraData: [] })),
  ).rejects.toMatchObject({
    name: "WindowsShortcutFormatFailure",
    kind: "malformed",
  });
});

it("reports an ExtraData size that overruns the file", async () => {
  const bytes = windowsShortcutBytes({ extraData: [], terminalBlock: false });
  const overrun = Buffer.concat([
    bytes,
    Buffer.from([0x40, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0xa0]),
  ]);
  const report = await parse(overrun);
  expect(report.coverage.status).toBe("partial");
  expect(
    report.issues.some((issue) => issue.code === "block_size_overrun"),
  ).toBe(true);
});

it("reports an odd Unicode StringData remainder", async () => {
  const header = windowsShortcutBytes({
    flags: 0x84,
    idList: null,
    linkInfo: null,
    extraData: [],
    terminalBlock: false,
    name: "A",
  });
  const truncated = header.subarray(0, header.length - 1);
  const report = await parse(truncated);
  expect(report.coverage.status).toBe("partial");
  expect(
    report.issues.some(
      (issue) =>
        issue.code === "odd_unicode_length" || issue.code === "truncated",
    ),
  ).toBe(true);
});

it("fails closed when the IDList item budget is exhausted", async () => {
  await expect(
    parse(powershellHiddenIconSpoofShortcut(), { max_id_list_items: 1 }),
  ).rejects.toBeInstanceOf(WindowsShortcutResourceFailure);
});

it("keeps unknown IDList items as raw hashed blobs", async () => {
  const report = await parse(
    windowsShortcutBytes({
      idList: [{ kind: "raw", data: Buffer.from([0x99, 0x01, 0x02, 0x03]) }],
      extraData: [],
    }),
  );
  expect(report.id_list?.items).toEqual([
    expect.objectContaining({
      kind: "raw",
      type_byte: 0x99,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    }),
  ]);
});

it("decodes UTF-16LE names on Unicode file-entry items", async () => {
  const header = Buffer.alloc(12);
  header[0] = 0x36;
  const name = Buffer.from("report.exe\0", "utf16le");
  const report = await parse(
    windowsShortcutBytes({
      idList: [{ kind: "raw", data: Buffer.concat([header, name]) }],
      extraData: [],
    }),
  );
  expect(report.id_list?.items).toEqual([
    expect.objectContaining({
      kind: "file_entry",
      type_byte: 0x36,
      entry_class: "file",
      short_name: "report.exe",
    }),
  ]);
  expect(report.observations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "target_extension",
        extension: ".exe",
      }),
    ]),
  );
});

it("keeps counted StringData bytes after an embedded NUL", async () => {
  const report = await parse(windowsShortcutBytes({ arguments: "a\0-hidden" }));
  expect(report.string_data.arguments?.value).toBe("a\0-hidden");
  expect(report.observations).toContainEqual({
    kind: "argument_length",
    evidence_kind: "derived",
    characters: 9,
  });
});

it("reports argument presence as unknown when HasArguments data is unreadable", async () => {
  // Cut the file inside COMMAND_LINE_ARGUMENTS so the field cannot be read.
  const report = await parse(
    windowsShortcutBytes({
      iconLocation: "",
      extraData: [],
      terminalBlock: false,
      omitStringBytes: 10,
    }),
  );
  expect(report.coverage.status).toBe("partial");
  expect(report.string_data.arguments).toBeNull();
  expect(report.observations).toContainEqual({
    kind: "arguments_present",
    evidence_kind: "derived",
    value: null,
  });
  expect(windowsShortcutSchema.safeParse(report).success).toBe(true);
});

it("derives the target extension from the joined base path and suffix", async () => {
  const report = await parse(
    windowsShortcutBytes({
      linkInfo: { localBasePath: "C:\\x", commonPathSuffix: "app.exe" },
      relativePath: "",
      idList: null,
    }),
  );
  expect(report.observations).toContainEqual({
    kind: "target_extension",
    evidence_kind: "derived",
    extension: ".exe",
  });
});

it("keeps readable dates for FILETIME values before 1970", async () => {
  // 1950-01-01T00:00:00Z in 100 ns intervals since 1601.
  const report = await parse(
    windowsShortcutBytes({ creationTime: 110133216000000000n }),
  );
  expect(report.header.creation_time.iso8601).toBe("1950-01-01T00:00:00.000Z");
});

it("marks an IDList without a TerminalID as partial", async () => {
  const bytes = windowsShortcutBytes({
    idList: [{ kind: "volume", name: "C:\\" }],
  });
  // Replace the IDList's TerminalID with a 2-byte empty ItemID of the same size.
  const declared = bytes.readUInt16LE(76);
  bytes.writeUInt16LE(2, 76 + declared);
  const report = await parse(bytes);
  expect(report.coverage.status).toBe("partial");
  expect(report.issues.map((issue) => issue.message)).toContain(
    "LinkTargetIDList has no TerminalID inside its declared size",
  );
});

it("charges the string budget before decoding a LinkInfo string", async () => {
  await expect(
    parse(
      windowsShortcutBytes({
        linkInfo: { localBasePath: `C:\\${"a".repeat(4096)}` },
      }),
      { max_string_bytes: 1 },
    ),
  ).rejects.toBeInstanceOf(WindowsShortcutResourceFailure);
});
