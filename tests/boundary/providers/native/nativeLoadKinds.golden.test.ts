import { expect, it } from "vitest";

import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import { parseOtoolLoadCommands } from "../../../../src/native/parsers/otool.js";
import {
  NativeFixtureRunner,
  nativeFixture,
  nativeMachoTarget,
  withOtoolMachHeader,
} from "../../../fixtures/nativeCommands.js";

it("retains lazily loaded library dependencies", () => {
  const load = parseOtoolLoadCommands(
    withOtoolMachHeader(
      [
        "Load command 0",
        "      cmd LC_LAZY_LOAD_DYLIB",
        "      cmdsize 48",
        "      name /usr/lib/libLazy.dylib (offset 24)",
        "   time stamp 2 Thu Jan  1 00:00:02 1970",
        "      current version 1.0.0",
        "compatibility version 1.0.0",
        "",
      ].join("\n"),
    ),
  );
  expect(load.dependencies).toContainEqual({
    path: "/usr/lib/libLazy.dylib",
    kind: "LC_LAZY_LOAD_DYLIB",
    current_version: "1.0.0",
    compatibility_version: "1.0.0",
  });
});

// Captured from the real Apple bundle CI fixture's `otool -h -l` output.
const delayedDylib = withOtoolMachHeader(`Load command 0
          cmd LC_LOAD_DYLIB
      cmdsize 56
         name @rpath/libdelay.dylib (offset 28)
      options delay-init
      current version 0.0.0
compatibility version 1.0.0
`);

it("preserves dylib-use options through native Mach-O inspection", async () => {
  const runner = new NativeFixtureRunner({ "otool:-h": delayedDylib });
  const client = new NativeMacOSProvider({}, runner, "darwin").createClient(
    nativeMachoTarget("/owned/fixture"),
  );
  const result = await client.execute("inspect_macho", {});
  if (!result.ok) throw result.error;
  expect(result.value.result).toMatchObject({
    load_commands: {
      items: [{ kind: "LC_LOAD_DYLIB", fields: { options: "delay-init" } }],
    },
    dependencies: {
      items: [
        {
          path: "@rpath/libdelay.dylib",
          kind: "LC_LOAD_DYLIB",
          current_version: "0.0.0",
          compatibility_version: "1.0.0",
        },
      ],
    },
  });
});

it("retains empty dylib-use options and rejects missing or ambiguous encoding fields", () => {
  expect(
    parseOtoolLoadCommands(delayedDylib.replace("delay-init", "")).commands[0]
      ?.fields.options,
  ).toBe("");
  const malformed: Array<readonly [string, RegExp]> = [
    ["", /timestamp or options/u],
    [
      "      options delay-init\n      options weak\n",
      /options is missing or repeated/u,
    ],
    [
      "      options delay-init\n   time stamp 2 Thu Jan  1 00:00:02 1970\n",
      /timestamp or options/u,
    ],
    [
      "      options delay-init\n      injected text\n",
      /ambiguous multiline text/u,
    ],
  ];
  for (const [replacement, reason] of malformed) {
    expect(() =>
      parseOtoolLoadCommands(
        delayedDylib.replace("      options delay-init\n", replacement),
      ),
    ).toThrow(reason);
  }
});

it.each(["vmaddr", "vmsize", "uuid", "entryoff"])(
  "rejects a required %s label truncated before its value",
  async (key) => {
    const raw = await nativeFixture("otool-load.txt");
    const truncated = raw.replace(
      new RegExp(`^(\\s*${key})\\s+\\S.*$`, "mu"),
      "$1",
    );
    expect(truncated).not.toBe(raw);
    expect(() => parseOtoolLoadCommands(raw)).not.toThrow();
    // Only the empty dylib-use options row may omit its value.
    expect(() => parseOtoolLoadCommands(truncated)).toThrow(
      `otool field ${key} has no value`,
    );
  },
);

it("retains the unnamed segment of a Mach-O object file", () => {
  // Captured from `otool -l` on a clang `-c` object: MH_OBJECT sections live
  // in one segment whose segname is empty, printed as a bare label.
  const objectSegment = [
    "Load command 0",
    "      cmd LC_SEGMENT_64",
    "  cmdsize 152",
    "  segname ",
    "   vmaddr 0x0000000000000000",
    "   vmsize 0x0000000000000018",
    "  fileoff 392",
    " filesize 24",
    "  maxprot 0x00000007",
    " initprot 0x00000007",
    "   nsects 1",
    "    flags 0x0",
    "Section",
    "  sectname __text",
    "   segname __TEXT",
    "      addr 0x0000000000000000",
    "      size 0x0000000000000018",
    "    offset 392",
    "     align 2^2 (4)",
    "    reloff 0",
    "    nreloc 0",
    "     flags 0x80000400",
    " reserved1 0",
    " reserved2 0",
    "",
  ].join("\n");
  const load = parseOtoolLoadCommands(withOtoolMachHeader(objectSegment));
  expect(load.segments).toMatchObject([
    { name: "unknown", sections: [{ segment: "__TEXT", name: "__text" }] },
  ]);
  // An all-NUL section name is printed the same way and stays "unknown".
  expect(
    parseOtoolLoadCommands(
      withOtoolMachHeader(
        objectSegment.replace("  sectname __text", "  sectname "),
      ),
    ).segments,
  ).toMatchObject([{ sections: [{ segment: "__TEXT", name: "unknown" }] }]);
  expect(() =>
    parseOtoolLoadCommands(
      withOtoolMachHeader(
        objectSegment.replace("   vmaddr 0x0000000000000000", "   vmaddr"),
      ),
    ),
  ).toThrow("otool field vmaddr has no value");
});

it("preserves dependency install names that begin with the word stamp", () => {
  const load = parseOtoolLoadCommands(
    withOtoolMachHeader(
      [
        "Load command 0",
        "          cmd LC_LOAD_DYLIB",
        "      cmdsize 48",
        "          name stamp plugin.dylib (offset 24)",
        "   time stamp 2 Thu Jan  1 00:00:02 1970",
        "      current version 1.0.0",
        "compatibility version 1.0.0",
        "",
      ].join("\n"),
    ),
  );
  expect(load.dependencies).toContainEqual({
    path: "stamp plugin.dylib",
    kind: "LC_LOAD_DYLIB",
    current_version: "1.0.0",
    compatibility_version: "1.0.0",
  });
  expect(
    load.commands.find((command) => command.kind === "LC_LOAD_DYLIB")?.fields[
      "time stamp"
    ],
  ).toMatch(/^2 Thu Jan/);
});

it("normalizes legacy version-minimum commands into build metadata", () => {
  const load = parseOtoolLoadCommands(
    withOtoolMachHeader(
      [
        "Load command 0",
        "      cmd LC_VERSION_MIN_MACOSX",
        "  cmdsize 16",
        "    version 10.13",
        "        sdk 10.15",
        "Load command 1",
        "      cmd LC_VERSION_MIN_IPHONEOS",
        "  cmdsize 16",
        "    version 12.0",
        "        sdk 12.1",
        "Load command 2",
        "      cmd LC_SOURCE_VERSION",
        "  cmdsize 16",
        "    version 1.2.3",
        "",
      ].join("\n"),
    ),
  );
  expect(load.builds).toEqual([
    {
      platform: "MACOSX",
      minimum_os: "10.13",
      sdk: "10.15",
      tools: [],
    },
    {
      platform: "IPHONEOS",
      minimum_os: "12.0",
      sdk: "12.1",
      tools: [],
    },
  ]);
});

it("names numeric build-version platforms and tools", () => {
  const load = parseOtoolLoadCommands(
    withOtoolMachHeader(
      [
        "Load command 0",
        "      cmd LC_BUILD_VERSION",
        "  cmdsize 48",
        " platform 1",
        "    minos 11.0",
        "      sdk 26.5",
        "   ntools 2",
        "     tool 3",
        "  version 1267.0",
        "     tool 1029",
        "  version 1.0",
        "Load command 1",
        "      cmd LC_BUILD_VERSION",
        "  cmdsize 24",
        " platform 99",
        "    minos 1.0",
        "      sdk 1.0",
        "   ntools 0",
        "Load command 2",
        "      cmd LC_BUILD_VERSION",
        "  cmdsize 32",
        " platform MACCATALYST",
        "    minos 14.0",
        "      sdk 14.2",
        "   ntools 1",
        "     tool SWIFT",
        "  version 5.9",
        "",
      ].join("\n"),
    ),
  );
  expect(load.builds).toEqual([
    {
      platform: "MACOS",
      minimum_os: "11.0",
      sdk: "26.5",
      tools: [
        { name: "LD", version: "1267.0" },
        { name: "1029", version: "1.0" },
      ],
    },
    { platform: "99", minimum_os: "1.0", sdk: "1.0", tools: [] },
    {
      platform: "MACCATALYST",
      minimum_os: "14.0",
      sdk: "14.2",
      tools: [{ name: "SWIFT", version: "5.9" }],
    },
  ]);
  expect(load.commands[0]?.fields.platform).toBe(1);
});

it("does not classify LC_LOAD_DYLINKER as a dylib dependency", async () => {
  const load = parseOtoolLoadCommands(
    await nativeFixture("native-macho-header/otool-header-load.txt"),
  );
  expect(load.commands.some(({ kind }) => kind === "LC_LOAD_DYLINKER")).toBe(
    true,
  );
  expect(load.dependencies.some(({ path }) => path === "/usr/lib/dyld")).toBe(
    false,
  );
});

it("limits thread-state entrypoints instead of reporting none silently", async () => {
  const runner = new NativeFixtureRunner({
    "otool:-h": withOtoolMachHeader(
      [
        "Load command 0",
        "      cmd LC_UNIXTHREAD",
        "      cmdsize 16",
        "      flavor 1",
        "      count 1",
        "",
      ].join("\n"),
    ),
  });
  const client = new NativeMacOSProvider({}, runner, "darwin").createClient(
    nativeMachoTarget("/owned/legacy-fixture"),
  );
  const result = await client.execute("inspect_macho", {});
  if (!result.ok) throw result.error;
  expect(result.value.result).toMatchObject({
    entrypoints: {
      items: [],
      total: null,
      exhaustive: false,
      limitations: [
        "Thread-state entrypoints (LC_UNIXTHREAD/LC_THREAD) are retained as raw load commands; file offsets are not derived.",
      ],
    },
  });
  expect(result.value.limitations).toContain(
    "Thread-state entrypoints (LC_UNIXTHREAD/LC_THREAD) are retained as raw load commands; file offsets are not derived.",
  );
});

it.each([
  ["1", "MACOS"],
  ["2", "IOS"],
  ["3", "TVOS"],
  ["4", "WATCHOS"],
  ["5", "BRIDGEOS"],
  ["6", "MACCATALYST"],
  ["7", "IOSSIMULATOR"],
  ["8", "TVOSSIMULATOR"],
  ["9", "WATCHOSSIMULATOR"],
  ["10", "DRIVERKIT"],
  ["11", "VISIONOS"],
  ["12", "VISIONOSSIMULATOR"],
  ["13", "FIRMWARE"],
  ["14", "SEPOS"],
  ["15", "MACOS_EXCLAVECORE"],
  ["16", "MACOS_EXCLAVEKIT"],
  ["17", "IOS_EXCLAVECORE"],
  ["18", "IOS_EXCLAVEKIT"],
  ["19", "TVOS_EXCLAVECORE"],
  ["20", "TVOS_EXCLAVEKIT"],
  ["21", "WATCHOS_EXCLAVECORE"],
  ["22", "WATCHOS_EXCLAVEKIT"],
  ["23", "VISIONOS_EXCLAVECORE"],
  ["24", "VISIONOS_EXCLAVEKIT"],
] as const)("names build platform %s as %s", (code, name) => {
  const load = parseOtoolLoadCommands(
    withOtoolMachHeader(
      [
        "Load command 0",
        "cmd LC_BUILD_VERSION",
        "cmdsize 24",
        `platform ${code}`,
        "minos 1.0",
        "sdk 1.0",
        "ntools 0",
        "",
      ].join("\n"),
    ),
  );
  expect(load.builds[0]?.platform).toBe(name);
});

it.each([
  ["1", "CLANG"],
  ["2", "SWIFT"],
  ["3", "LD"],
  ["4", "LLD"],
  ["1024", "METAL"],
  ["1025", "AIRLLD"],
  ["1026", "AIRNT"],
  ["1027", "AIRNT_PLUGIN"],
  ["1028", "AIRPACK"],
  ["1031", "GPUARCHIVER"],
  ["1032", "METAL_FRAMEWORK"],
] as const)("names build tool %s as %s", (code, name) => {
  const load = parseOtoolLoadCommands(
    withOtoolMachHeader(
      [
        "Load command 0",
        "cmd LC_BUILD_VERSION",
        "cmdsize 32",
        "platform 1",
        "minos 1.0",
        "sdk 1.0",
        "ntools 1",
        `tool ${code}`,
        "version 1.0",
        "",
      ].join("\n"),
    ),
  );
  expect(load.builds[0]?.tools).toEqual([{ name, version: "1.0" }]);
});
