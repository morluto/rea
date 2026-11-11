import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  inspectWindowsShortcutInputSchema,
  windowsShortcutSchema,
} from "../../domain/native/windowsShortcut.js";
import {
  ansiShortcut,
  LINK_FLAG,
  networkShareShortcut,
  powershellHiddenIconSpoofShortcut,
  TRACKER_MAC,
  TRACKER_UUID_TIMESTAMP,
  truncatedStringDataShortcut,
  unknownExtraDataShortcut,
  uuidV1Bytes,
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

it.each([false, true])(
  "reads network-share LinkInfo names with Unicode %s",
  async (unicode) => {
    const report = await parse(
      unicode
        ? networkShareShortcut()
        : windowsShortcutBytes({
            flags: LINK_FLAG.HasLinkInfo,
            unicode: false,
            idList: null,
            linkInfo: { netName: "\\\\fileserver\\docs", deviceName: "Z:" },
            extraData: [],
          }),
    );
    expect(report.link_info?.common_network_relative_link).toMatchObject({
      net_name: "\\\\fileserver\\docs",
      device_name: "Z:",
      net_name_unicode: unicode ? "\\\\fileserver\\docs" : null,
      device_name_unicode: unicode ? "Z:" : null,
    });
    expect(report.coverage.status).toBe("complete");
    expect(report.issues).toEqual([]);
  },
);

it("reports the network provider type only when ValidNetType is set", async () => {
  const build = (networkFlags: number) =>
    windowsShortcutBytes({
      flags: LINK_FLAG.HasLinkInfo | LINK_FLAG.IsUnicode,
      linkInfo: {
        netName: "\\\\fileserver\\docs",
        deviceName: "Z:",
        networkProviderType: 0x00020000,
        networkFlags,
        commonPathSuffix: "report.docx",
      },
      extraData: [],
    });
  const valid = await parse(build(0x3));
  expect(valid.link_info?.common_network_relative_link).toMatchObject({
    network_provider_type: 0x00020000,
  });
  const ignored = await parse(build(0x1));
  expect(ignored.link_info?.common_network_relative_link).toMatchObject({
    network_provider_type: null,
  });
});

it("ignores device names when ValidDevice is clear", async () => {
  const bytes = windowsShortcutBytes({
    flags: LINK_FLAG.HasLinkInfo | LINK_FLAG.IsUnicode,
    linkInfo: {
      netName: "\\\\fileserver\\docs",
      deviceName: "Z:",
      networkFlags: 0x2,
      commonPathSuffix: "report.docx",
    },
    extraData: [],
  });
  // Point the ignored DeviceNameOffset fields outside the block.
  const block =
    bytes.indexOf(Buffer.from("\\\\fileserver\\docs\0", "latin1")) - 0x1c;
  bytes.writeUInt32LE(0xffff, block + 12);
  bytes.writeUInt32LE(0xffff, block + 24);
  const report = await parse(bytes);
  expect(report.link_info?.common_network_relative_link).toMatchObject({
    net_name: "\\\\fileserver\\docs",
    device_name: null,
    device_name_unicode: null,
    network_provider_type: 0x00020000,
  });
  expect(report.issues).toEqual([]);
  expect(report.coverage.status).toBe("complete");
});

it("retains ANSI network names with partial coverage when declared Unicode offsets are truncated", async () => {
  const bytes = windowsShortcutBytes({
    flags: LINK_FLAG.HasLinkInfo,
    idList: null,
    linkInfo: { netName: "\\\\server\\share", networkFlags: 0x2 },
    extraData: [],
  });
  const network = 76 + bytes.readUInt32LE(76 + 20);
  bytes.writeUInt32LE(24, network);
  bytes.writeUInt32LE(21, network + 8);
  bytes[network + 21] = 0x78;
  bytes[network + 22] = 0;
  const report = await parse(bytes);
  expect(report.link_info?.common_network_relative_link).toMatchObject({
    net_name: "x",
    net_name_unicode: null,
  });
  expect(report.artifact).toEqual(artifact(bytes));
  expect(report.coverage).toMatchObject({
    status: "partial",
    failing_offset: network + 20,
  });
  expect(report.coverage.reason).not.toBeNull();
  expect(report.issues).toEqual([
    {
      code: "truncated",
      offset: network + 20,
      message:
        "CommonNetworkRelativeLink ends before its declared Unicode offsets",
    },
  ]);
  expect(report.link_info?.common_path_suffix).toBe("");
  expect(report.extra_data.terminal_offset).not.toBeNull();
  expect(windowsShortcutSchema.safeParse(report).success).toBe(true);
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

it("does not derive Tracker facts from non-RFC 4122 variant GUIDs", async () => {
  const ncsVariant = uuidV1Bytes(TRACKER_UUID_TIMESTAMP, 2, TRACKER_MAC);
  ncsVariant[8] = 0x00;
  const valid = uuidV1Bytes(TRACKER_UUID_TIMESTAMP, 1, TRACKER_MAC);
  const report = await parse(
    windowsShortcutBytes({
      extraData: [{ kind: "tracker", droid: [valid, ncsVariant] }],
    }),
  );
  const tracker = report.extra_data.blocks.find(
    (block) => block.decoded.kind === "tracker",
  );
  if (tracker?.decoded.kind !== "tracker")
    throw new Error("Expected a TrackerDataBlock");
  expect(tracker.decoded.droid_uuid_v1[0]).not.toBeNull();
  expect(tracker.decoded.droid_uuid_v1[1]).toBeNull();
  expect(tracker.decoded.droid[1]).toEqual(expect.any(String));
});

it.each([
  { length: 0, version: 0 },
  { length: 0x58, version: 1 },
])(
  "keeps a Tracker block with Length $length and Version $version as raw data",
  async ({ length, version }) => {
    const report = await parse(
      windowsShortcutBytes({
        extraData: [{ kind: "tracker", length, version }],
      }),
    );
    const tracker = report.extra_data.blocks.find(
      (block) => block.signature === 0xa0000003,
    );
    expect(tracker?.decoded.kind).toBe("raw");
    expect(
      report.issues.some((issue) => issue.code === "malformed_structure"),
    ).toBe(true);
    expect(report.coverage.status).toBe("partial");
    expect(windowsShortcutSchema.safeParse(report).success).toBe(true);
  },
);

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

it.each([12, 16, 20, 24, 28, 32])(
  "points an out-of-range LinkInfo offset at its field at byte %i",
  async (field) => {
    const bytes = windowsShortcutBytes({
      idList: null,
      linkInfo: {
        localBasePath: "C:\\target.exe",
        netName: "\\\\server\\share",
      },
    });
    bytes.writeUInt32LE(0xffffffff, 76 + field);
    const report = await parse(bytes);
    expect(report.coverage.status).toBe("partial");
    expect(report.coverage.failing_offset).toBe(76 + field);
    expect(report.issues.every((issue) => issue.offset < bytes.length)).toBe(
      true,
    );
    expect(windowsShortcutSchema.safeParse(report).success).toBe(true);
  },
);

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

const HAS_EXP_STRING = 0x00000200;
const HAS_EXP_ICON = 0x00004000;

/** Set extra LinkFlags on an already built shortcut. */
const withLinkFlags = (bytes: Buffer, added: number): Buffer => {
  const flagged = Buffer.from(bytes);
  flagged.writeUInt32LE((flagged.readUInt32LE(0x14) | added) >>> 0, 0x14);
  return flagged;
};

const missingBlockIssues = (report: { issues: readonly { code: string }[] }) =>
  report.issues.filter((issue) => issue.code === "missing_extra_data_block");

it("reports an expected block as absent once the TerminalBlock is read", async () => {
  const report = await parse(
    withLinkFlags(
      windowsShortcutBytes({ extraData: [] }),
      HAS_EXP_STRING | HAS_EXP_ICON,
    ),
  );
  expect(report.extra_data.terminal_offset).toEqual(expect.any(Number));
  expect(missingBlockIssues(report)).toEqual([
    expect.objectContaining({
      message: "HasExpString is set and EnvironmentVariableDataBlock is absent",
    }),
    expect.objectContaining({
      message: "HasExpIcon is set and IconEnvironmentDataBlock is absent",
    }),
  ]);
  expect(windowsShortcutSchema.safeParse(report).success).toBe(true);
});

it("keeps an expected block unknown when StringData stops before ExtraData", async () => {
  const report = await parse(
    withLinkFlags(truncatedStringDataShortcut(), HAS_EXP_STRING),
  );
  expect(report.coverage.status).toBe("partial");
  expect(report.extra_data.terminal_offset).toBeNull();
  expect(missingBlockIssues(report)).toEqual([]);
});

it("keeps an expected block unknown when an ExtraData block overruns the file", async () => {
  const bytes = windowsShortcutBytes({ extraData: [], terminalBlock: false });
  const report = await parse(
    withLinkFlags(
      Buffer.concat([
        bytes,
        Buffer.from([0x40, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0xa0]),
      ]),
      HAS_EXP_ICON,
    ),
  );
  expect(report.coverage.status).toBe("partial");
  expect(missingBlockIssues(report)).toEqual([]);
});

it("treats any TerminalSize below 4 as the ExtraData terminal", async () => {
  const base = windowsShortcutBytes({ extraData: [], terminalBlock: false });
  for (const size of [1, 2, 3]) {
    const report = await parse(
      Buffer.concat([base, Buffer.from([size, 0x00, 0x00, 0x00])]),
    );
    expect(report.extra_data.terminal_offset).toBe(base.length);
    expect(report.coverage.status).toBe("complete");
  }
});

it("derives target facts from a stored environment target alone", async () => {
  const report = await parse(
    windowsShortcutBytes({
      flags: LINK_FLAG.IsUnicode | LINK_FLAG.HasIconLocation,
      iconLocation: "C:\\Tools\\app.exe",
      extraData: [
        {
          kind: "environment",
          ansi: "C:\\Tools\\app.exe",
          unicode: "C:\\Tools\\app.exe",
        },
      ],
    }),
  );
  expect(report.observations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "target_extension",
        extension: ".exe",
      }),
      expect.objectContaining({
        kind: "icon_location_differs_from_target",
        value: false,
      }),
    ]),
  );
});

it("reports partial coverage when an expected block has no ExtraData to read", async () => {
  const report = await parse(
    withLinkFlags(
      windowsShortcutBytes({ extraData: [], terminalBlock: false }),
      HAS_EXP_STRING,
    ),
  );
  expect(report.coverage.status).toBe("partial");
  expect(report.issues).toEqual([
    expect.objectContaining({
      code: "truncated",
      message: "ExtraData TerminalBlock is absent",
    }),
  ]);
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

it("reads a Unicode volume label without inventing an ANSI label", async () => {
  const report = await parse(
    windowsShortcutBytes({ linkInfo: { label: "OS" } }),
  );
  expect(report.link_info?.volume).toMatchObject({
    label: null,
    label_unicode: "OS",
  });
  expect(report.issues).toEqual([]);
});

it("does not read a Unicode label offset past an ANSI label offset", async () => {
  const report = await parse(
    windowsShortcutBytes({
      unicode: false,
      linkInfo: {
        label: "DATA",
        // At the position of VolumeLabelOffsetUnicode, which is absent here.
        volumeLabelGap: Buffer.from([0x18, 0, 0, 0, 0, 0, 0, 0]),
      },
    }),
  );
  expect(report.link_info?.volume).toMatchObject({
    label: "DATA",
    label_unicode: null,
  });
  expect(report.issues).toEqual([]);
});

it("reports a VolumeID that selects a Unicode label it cannot hold", async () => {
  const bytes = windowsShortcutBytes({
    idList: null,
    linkInfo: { label: "OS" },
  });
  const linkInfo = 76;
  const volume = linkInfo + bytes.readUInt32LE(linkInfo + 12);
  bytes.writeUInt32LE(16, volume);
  const report = await parse(bytes);
  expect(report.link_info?.volume).toMatchObject({
    label: null,
    label_unicode: null,
  });
  expect(report.issues).toContainEqual(
    expect.objectContaining({ code: "truncated", offset: volume + 16 }),
  );
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
  expect(report.issues).toContainEqual(
    expect.objectContaining({
      code: "malformed_structure",
      offset: 78 + declared,
    }),
  );
});

const iconDifference = (
  report: Awaited<ReturnType<typeof parse>>,
): boolean | null | undefined => {
  const observation = report.observations.find(
    ({ kind }) => kind === "icon_location_differs_from_target",
  );
  return observation?.kind === "icon_location_differs_from_target"
    ? observation.value
    : undefined;
};

it("leaves the icon comparison unknown when only a filename is stored", async () => {
  const report = await parse(
    windowsShortcutBytes({
      linkInfo: null,
      idList: [
        { kind: "file", shortName: "app.exe", fileSize: 1, classType: 0x32 },
      ],
      iconLocation: "C:\\Tools\\app.exe",
    }),
  );
  expect(iconDifference(report)).toBeNull();
});

it("leaves the icon comparison unknown for a relative target or icon", async () => {
  const relativeTarget = await parse(
    windowsShortcutBytes({
      linkInfo: null,
      relativePath: ".\\app.exe",
      iconLocation: "C:\\Tools\\app.exe",
    }),
  );
  expect(iconDifference(relativeTarget)).toBeNull();

  const environmentIcon = await parse(
    windowsShortcutBytes({
      linkInfo: { localBasePath: "C:\\Windows\\System32\\cmd.exe" },
      iconLocation: "%SystemRoot%\\System32\\cmd.exe",
    }),
  );
  expect(iconDifference(environmentIcon)).toBeNull();
});

it("compares an icon with a full target path, ignoring case and separators", async () => {
  const same = await parse(
    windowsShortcutBytes({
      linkInfo: { localBasePath: "C:\\Tools\\app.exe" },
      iconLocation: "c:/tools/APP.exe",
    }),
  );
  expect(iconDifference(same)).toBe(false);

  const different = await parse(
    windowsShortcutBytes({
      linkInfo: { localBasePath: "C:\\Tools\\app.exe" },
      iconLocation: "C:\\Tools\\other.exe",
    }),
  );
  expect(iconDifference(different)).toBe(true);
});

it("compares an icon with a target only in a shared or ASCII encoding", async () => {
  // Windows stores the LinkInfo path only as ANSI when the system code page can
  // represent it. 0xB9 0xA4 0xBE 0xDF is "工具" in code page 936; Latin1 differs.
  const gbk = "D:\\\u00b9\u00a4\u00be\u00df\\app.exe";
  const iconFor = async (
    options: Parameters<typeof windowsShortcutBytes>[0],
  ): Promise<boolean | null | undefined> =>
    iconDifference(await parse(windowsShortcutBytes(options)));
  const ansiLinkInfo = (localBasePath: string) => ({
    localBasePath,
    unicode: false,
  });
  expect(
    await iconFor({
      linkInfo: ansiLinkInfo(gbk),
      iconLocation: "D:\\工具\\app.exe",
    }),
  ).toBeNull();
  // A different comparable target does not outweigh the one that cannot be read.
  expect(
    await iconFor({
      linkInfo: ansiLinkInfo(gbk),
      extraData: [{ kind: "environment", unicode: "C:\\Other\\x.exe" }],
      iconLocation: "D:\\工具\\app.exe",
    }),
  ).toBeNull();
  // An ANSI icon cannot be compared with a Unicode target either.
  expect(
    await iconFor({
      unicode: false,
      linkInfo: { localBasePath: "D:\\工具\\app.exe", unicode: true },
      iconLocation: gbk,
    }),
  ).toBeNull();
  // Both ANSI: the same code page, so the bytes compare.
  for (const [iconLocation, differs] of [
    [gbk, false],
    ["D:\\\u00b9\u00a4\u00be\u00df\\other.exe", true],
  ] as const)
    expect(
      await iconFor({
        unicode: false,
        linkInfo: { localBasePath: gbk },
        iconLocation,
      }),
    ).toBe(differs);
  // ASCII is the same text in every ANSI code page, so it still compares.
  for (const [iconLocation, differs] of [
    ["C:\\Tools\\app.exe", false],
    ["C:\\Tools\\other.exe", true],
  ] as const)
    expect(
      await iconFor({
        linkInfo: ansiLinkInfo("C:\\Tools\\app.exe"),
        iconLocation,
      }),
    ).toBe(differs);
  // A joined path keeps each part's encoding: an ASCII ANSI share with a
  // Unicode suffix, or a Unicode share with an ASCII ANSI suffix, compares.
  for (const [linkInfo, iconLocation, differs] of [
    [
      { netName: "\\\\server\\share", commonPathSuffix: "工具\\app.exe" },
      "\\\\server\\share\\工具\\app.exe",
      false,
    ],
    [
      { netName: "\\\\server\\share", commonPathSuffix: "工具\\app.exe" },
      "\\\\server\\share\\工具\\other.exe",
      true,
    ],
  ] as const)
    expect(
      await iconFor({
        linkInfo: { ...linkInfo, unicode: true, networkUnicode: false },
        iconLocation,
      }),
    ).toBe(differs);
  expect(
    await iconFor({
      linkInfo: {
        netName: "\\\\server\\共享",
        commonPathSuffix: "app.exe",
        unicode: false,
        networkUnicode: true,
      },
      iconLocation: "\\\\server\\共享\\app.exe",
    }),
  ).toBe(false);
});

it("compares an icon with a target after collapsing dot segments as text", async () => {
  const iconFor = async (localBasePath: string, iconLocation: string) =>
    iconDifference(
      await parse(
        windowsShortcutBytes({ linkInfo: { localBasePath }, iconLocation }),
      ),
    );
  expect(await iconFor("C:\\Tools\\.\\app.exe", "C:\\Tools\\app.exe")).toBe(
    false,
  );
  expect(
    await iconFor("C:\\Tools\\bin\\..\\\\app.exe", "c:/tools//app.exe"),
  ).toBe(false);
  // `..` stops at the drive root and the UNC share root.
  expect(await iconFor("C:\\..\\..\\app.exe", "C:\\app.exe")).toBe(false);
  expect(
    await iconFor(
      "\\\\server\\share\\..\\app.exe",
      "\\\\server\\share\\app.exe",
    ),
  ).toBe(false);
  expect(
    await iconFor("\\\\server\\share\\..\\app.exe", "\\\\server\\app.exe"),
  ).toBe(true);
  // A repeated separator after the host still leaves the share in the root.
  expect(
    await iconFor(
      "\\\\server\\\\shareA\\..\\app.exe",
      "\\\\server\\\\shareB\\..\\app.exe",
    ),
  ).toBe(true);
  expect(
    await iconFor(
      "\\\\server\\\\share\\..\\app.exe",
      "\\\\server\\share\\app.exe",
    ),
  ).toBe(false);
  expect(await iconFor("C:\\Tools\\..\\app.exe", "C:\\Tools\\app.exe")).toBe(
    true,
  );
});

it("compares an icon with the joined base path and suffix, not the bare base", async () => {
  const report = await parse(
    windowsShortcutBytes({
      linkInfo: { localBasePath: "C:\\Tools", commonPathSuffix: "app.exe" },
      iconLocation: "C:\\Tools",
    }),
  );
  expect(iconDifference(report)).toBe(true);
});

it("leaves the icon comparison unknown when a stored target keeps an unexpanded variable", async () => {
  const environmentTarget = {
    kind: "environment",
    ansi: "C:\\Users\\%USERNAME%\\app.exe",
    unicode: "C:\\Users\\%USERNAME%\\app.exe",
  } as const;
  const variableOnly = await parse(
    windowsShortcutBytes({
      flags: LINK_FLAG.IsUnicode | LINK_FLAG.HasIconLocation,
      iconLocation: "C:\\Users\\Alice\\app.exe",
      extraData: [environmentTarget],
    }),
  );
  expect(iconDifference(variableOnly)).toBeNull();

  const withFixedTarget = await parse(
    windowsShortcutBytes({
      linkInfo: { localBasePath: "C:\\Tools\\app.exe" },
      iconLocation: "C:\\Users\\Alice\\app.exe",
      extraData: [environmentTarget],
    }),
  );
  expect(iconDifference(withFixedTarget)).toBeNull();

  const matchesFixed = await parse(
    windowsShortcutBytes({
      linkInfo: { localBasePath: "C:\\Tools\\app.exe" },
      iconLocation: "C:\\Tools\\app.exe",
      extraData: [environmentTarget],
    }),
  );
  expect(iconDifference(matchesFixed)).toBe(false);
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
