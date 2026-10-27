import { expect, it } from "vitest";
import { inspectMachoSchema } from "../../../../src/domain/native/nativeInspection.js";
import { projectAnalysisView } from "../../../../src/domain/analysisView/analysisView.js";

import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import { parseOtoolLoadCommands } from "../../../../src/native/parsers/otool.js";
import {
  NativeFixtureRunner,
  nativeFixture,
  nativeMachoTarget,
  withOtoolMachHeader,
} from "../../../fixtures/nativeCommands.js";

it("retains the delayed dependency in the complete real framed otool output", async () => {
  const output = await nativeFixture("otool-dylib-use.txt");
  const runner = new NativeFixtureRunner({ "otool:-h": output });
  const client = new NativeMacOSProvider({}, runner, "darwin").createClient(
    nativeMachoTarget("/owned/fixture"),
  );
  const result = await client.execute("inspect_macho", {});
  if (!result.ok) throw result.error;
  expect(result.value.result).toMatchObject({
    load_commands: {
      items: expect.arrayContaining([
        expect.objectContaining({
          index: 16,
          kind: "LC_LOAD_DYLIB",
          fields: expect.objectContaining({ options: "delay-init" }),
        }),
      ]),
    },
    dependencies: {
      items: expect.arrayContaining([
        expect.objectContaining({
          path: "@rpath/libdelay.dylib",
          current_version: "0.0.0",
          compatibility_version: "1.0.0",
        }),
      ]),
    },
  });
  expect(parseOtoolLoadCommands(output).commands).toHaveLength(23);
});

it.each([
  ["0xfeedfacf 16777228", 64, "little"],
  ["0xfeedfacf 16777223", 64, "little"],
  ["0xfeedface        7", 32, "little"],
  ["0xfeedface       18", 32, "big"],
  ["0xfeedface        6", 32, null],
  ["0xfeedfade 16777228", null, "little"],
] as const)(
  "derives word size and byte order from the selected slice header %s",
  async (header, wordSize, endian) => {
    const output = (await nativeFixture("otool-dylib-use.txt")).replace(
      "0xfeedfacf 16777228",
      header,
    );
    expect(parseOtoolLoadCommands(output)).toMatchObject({ wordSize, endian });
  },
);

it("rejects a repeated options field even when the duplicate has no value", async () => {
  const output = (await nativeFixture("otool-dylib-use.txt")).replace(
    "      options delay-init",
    "      options delay-init\n      options",
  );
  expect(() => parseOtoolLoadCommands(output)).toThrow(/otool/u);
});

it.each([
  "vmaddr",
  "vmsize",
  "uuid",
  "entryoff",
  "addr",
  "current version",
  "time stamp",
])(
  "rejects a required %s label with no value and retains its producer output",
  async (field) => {
    const original = await nativeFixture("otool-load.txt");
    const output = original.replace(
      new RegExp(`^([ \\t]*${field})[ \\t]+\\S[^\\n]*$`, "mu"),
      "$1",
    );
    if (output === original) throw new Error(`Fixture has no ${field} value`);
    const runner = new NativeFixtureRunner({ "otool:-h": output });
    const client = new NativeMacOSProvider({}, runner, "darwin").createClient(
      nativeMachoTarget("/owned/fixture"),
    );
    const result = await client.execute("inspect_macho", {});
    if (result.ok) throw new Error(`Expected missing ${field} value rejection`);
    expect(result.error).toMatchObject({
      _tag: "AnalysisOutputError",
      capturedOutput: { stdout: output, stderr: "", truncated: false },
    });
    expect(result.error.cause).toMatchObject({
      message: expect.stringContaining(field),
    });
  },
);

it("collects the actual Mach header alongside the native load commands", async () => {
  // The provider always invokes `otool -h -l`, which the runner resolves
  // via the "otool:-h" key; no bare `otool` override is needed.
  const runner = new NativeFixtureRunner({
    "otool:-h": await nativeFixture(
      "native-macho-header/otool-header-load.txt",
    ),
  });
  const client = new NativeMacOSProvider({}, runner, "darwin").createClient(
    nativeMachoTarget("/owned/fixture"),
  );
  const result = await client.execute("inspect_macho", {});
  if (!result.ok) throw result.error;
  expect(result.value.result).toMatchObject({
    file_type: "2",
    flags: ["0x00200085"],
    segments: {
      items: expect.arrayContaining([
        expect.objectContaining({ name: "__TEXT" }),
      ]),
    },
  });
});

it("rejects line breaks in a dylib name that manufacture a command and retains otool output", async () => {
  const output = [
    "/owned/fixture:",
    "Mach header",
    "      magic cputype cpusubtype caps filetype ncmds sizeofcmds flags",
    " 0xfeedfacf 16777228 0 0x00 2 1 120 0x00000000",
    "Load command 0",
    "          cmd LC_LOAD_DYLIB",
    "      cmdsize 120",
    "         name @rpath/a",
    "Load command 77",
    "      cmd LC_REEXPORT_DYLIB",
    "         name /evil.dylib (offset 24)",
    "   time stamp 2 Thu Jan  1 00:00:02 1970",
    "      current version 1.0.0",
    "compatibility version 1.0.0",
    "",
  ].join("\n");
  const runner = new NativeFixtureRunner({ "otool:-h": output });
  const client = new NativeMacOSProvider({}, runner, "darwin").createClient(
    nativeMachoTarget("/owned/fixture"),
  );
  const result = await client.execute("inspect_macho", {});
  if (result.ok) throw new Error("expected malformed otool framing to fail");
  expect(result.error).toMatchObject({
    _tag: "AnalysisOutputError",
    capturedOutput: { stdout: output, stderr: "", truncated: false },
  });
});

it("does not reinterpret segment and section flags as Mach header flags", async () => {
  const load = parseOtoolLoadCommands(
    await nativeFixture("native-macho-header/otool-header-load.txt"),
  );
  expect(load.flags).toEqual(["0x00200085"]);
  expect(load.commands.some((command) => command.fields.flags === 0)).toBe(
    true,
  );
});

it("keeps multi-word field names such as time stamp intact", async () => {
  const load = parseOtoolLoadCommands(await nativeFixture("otool-load.txt"));
  const stamped = load.commands.filter(
    (command) => "time stamp" in command.fields,
  );
  expect(stamped.length).toBeGreaterThan(0);
  expect(load.commands.some((command) => "time" in command.fields)).toBe(false);
  expect(stamped[0]?.fields["time stamp"]).toMatch(/^2 Thu Jan/);
});

it("decodes Mach header fields by their column names", () => {
  const reordered = parseOtoolLoadCommands(
    [
      "Mach header",
      " flags filetype magic cputype ncmds sizeofcmds",
      " NOUNDEFS 2 0xfeedfacf 16777228 0 0",
    ].join("\n"),
  );
  expect(reordered.fileType).toBe("2");
  expect(reordered.flags).toEqual(["NOUNDEFS"]);
  const reorderedMultiwordFlags = parseOtoolLoadCommands(
    [
      "Mach header",
      " filetype magic flags ncmds sizeofcmds",
      " 2 0xfeedfacf NOUNDEFS DYLDLINK 0 0",
    ].join("\n"),
  );
  expect(reorderedMultiwordFlags.fileType).toBe("2");
  expect(reorderedMultiwordFlags.flags).toEqual(["DYLDLINK", "NOUNDEFS"]);
  expect(() =>
    parseOtoolLoadCommands(
      "Mach header\n magic cputype flags\n 0xfeedfacf 1 NOUNDEFS\n",
    ),
  ).toThrow(/command framing/u);
  expect(() =>
    parseOtoolLoadCommands(
      "Mach header\n filetype magic flags ncmds sizeofcmds\n 2 0xfeedfacf NOUNDEFS\n",
    ),
  ).toThrow(/command framing/u);
});

it("rejects duplicate semantic fields, injected sections, and truncated framing", () => {
  const duplicateUuid = withOtoolMachHeader(`Load command 0
      cmd LC_UUID
  cmdsize 24
     uuid 01234567-89ab-cdef-0123-456789abcdef
     uuid fedcba98-7654-3210-fedc-ba9876543210
`);
  expect(() => parseOtoolLoadCommands(duplicateUuid)).toThrow(/uuid/u);

  const injectedSection = withOtoolMachHeader(`Load command 0
      cmd LC_SEGMENT_64
  cmdsize 152
  segname __TEXT
Section
  sectname __fake
   segname __TEXT
      addr 0x1000
      size 0x10
    offset 4096
     align 2^0 (1)
     flags 0x0
`);
  expect(() => parseOtoolLoadCommands(injectedSection)).toThrow(/vmaddr/u);

  const incorrectSectionCount = withOtoolMachHeader(`Load command 0
      cmd LC_SEGMENT_64
  cmdsize 152
  segname __TEXT
   vmaddr 0x100000000
   vmsize 0x2000
  fileoff 0
 filesize 8192
  maxprot 0x5
 initprot 0x5
   nsects 0
    flags 0x0
Section
  sectname __text
   segname __TEXT
      addr 0x100001000
      size 0x100
    offset 4096
     align 4
     flags 0x0
`);
  expect(() => parseOtoolLoadCommands(incorrectSectionCount)).toThrow(
    /section count/u,
  );

  const truncatedCount = [
    "Mach header",
    "      magic cputype cpusubtype caps filetype ncmds sizeofcmds flags",
    " 0xfeedfacf 16777228 0 0x00 2 2 48 0x00000000",
    "Load command 0",
    "      cmd LC_UUID",
    "  cmdsize 24",
    "     uuid 01234567-89ab-cdef-0123-456789abcdef",
  ].join("\n");
  expect(() => parseOtoolLoadCommands(truncatedCount)).toThrow(/count/u);

  const truncatedBytes = truncatedCount.replace("2 2 48", "2 1 32");
  expect(() => parseOtoolLoadCommands(truncatedBytes)).toThrow(/sizes/u);
});

it.each([
  ["LC_VERSION_MIN_IPHONEOS", 7, "IOSSIMULATOR"],
  ["LC_VERSION_MIN_IPHONEOS", 16777223, "IOSSIMULATOR"],
  ["LC_VERSION_MIN_IPHONEOS", 16777228, "IPHONEOS"],
  ["LC_VERSION_MIN_TVOS", 7, "TVOS"],
  ["LC_VERSION_MIN_TVOS", 16777223, "TVOSSIMULATOR"],
  ["LC_VERSION_MIN_TVOS", 16777228, "TVOS"],
  ["LC_VERSION_MIN_WATCHOS", 7, "WATCHOSSIMULATOR"],
  ["LC_VERSION_MIN_WATCHOS", 16777223, "WATCHOSSIMULATOR"],
  ["LC_VERSION_MIN_WATCHOS", 16777228, "WATCHOS"],
  ["LC_VERSION_MIN_MACOSX", 7, "MACOSX"],
  ["LC_VERSION_MIN_MACOSX", 16777223, "MACOSX"],
  ["LC_VERSION_MIN_MACOSX", 16777228, "MACOSX"],
])(
  "classifies legacy command %s on CPU %s as %s",
  (command, cpuType, platform) => {
    const text = [
      "Mach header",
      "      magic cputype cpusubtype caps filetype ncmds sizeofcmds flags",
      ` ${cpuType === 7 ? "0xfeedface" : "0xfeedfacf"} ${cpuType} 3 0x00 2 1 16 0x0`,
      "Load command 0",
      `      cmd ${command}`,
      "  cmdsize 16",
      "   version 12.0",
      "       sdk 12.1",
    ].join("\n");
    expect(parseOtoolLoadCommands(text).builds[0]?.platform).toBe(platform);
  },
);

it.each([
  ["3", "TVOS"],
  ["4294967295", "4294967295"],
])("preserves explicit build platform %s on Intel", (code, platform) => {
  const text = [
    "Mach header",
    "      magic cputype cpusubtype caps filetype ncmds sizeofcmds flags",
    " 0xfeedfacf 16777223 3 0x00 2 1 24 0x0",
    "Load command 0",
    "      cmd LC_BUILD_VERSION",
    "  cmdsize 24",
    ` platform ${code}`,
    "    minos 12.0",
    "      sdk 12.1",
    "   ntools 0",
  ].join("\n");
  expect(parseOtoolLoadCommands(text).builds[0]?.platform).toBe(platform);
});

it("preserves an unknown legacy platform spelling on Intel", () => {
  const text = [
    "Mach header",
    "      magic cputype cpusubtype caps filetype ncmds sizeofcmds flags",
    " 0xfeedfacf 16777223 3 0x00 2 1 16 0x0",
    "Load command 0",
    "      cmd LC_VERSION_MIN_FUTURE",
    "  cmdsize 16",
    "   version 12.0",
    "       sdk 12.1",
  ].join("\n");
  const result = parseOtoolLoadCommands(text);
  expect(result.builds[0]?.platform).toBe("FUTURE");
  expect(result.commands[0]?.kind).toBe("LC_VERSION_MIN_FUTURE");
});

it("retains unknown otool field labels through the inspection contract and Mach-O page", async () => {
  const output = (await nativeFixture("otool-dylib-use.txt")).replace(
    /^(\s*cmdsize \d+)$/mu,
    "$1\n __proto__ selected-source\n constructor 17\n repeated first\n repeated second",
  );
  const parsed = parseOtoolLoadCommands(output);
  const fields = parsed.commands[0]!.fields;
  expect(Object.hasOwn(fields, "__proto__")).toBe(true);
  expect(fields["__proto__"]).toBe("selected-source");
  expect(fields.constructor).toBe(17);
  expect(fields["repeated #1"]).toBe("first");
  expect(fields["repeated #2"]).toBe("second");
  const runner = new NativeFixtureRunner({ "otool:-h": output });
  const client = new NativeMacOSProvider({}, runner, "darwin").createClient(
    nativeMachoTarget("/owned/fixture"),
  );
  const result = await client.execute("inspect_macho", {});
  if (!result.ok) throw result.error;
  const observed = inspectMachoSchema.parse(result.value.result);
  expect(
    Object.hasOwn(observed.load_commands.items[0]!.fields, "__proto__"),
  ).toBe(true);
  const projected = projectAnalysisView(
    {
      evidenceId: `ev_${"c".repeat(64)}`,
      operation: "inspect_macho",
      normalizedResult: observed,
      subject: null,
      limitations: [],
    },
    { kind: "macho", facet: "load_commands", offset: 0, limit: 64 },
  );
  if (!projected.ok) throw projected.error;
  if (projected.value.kind !== "macho") throw new Error("Expected Mach-O view");
  expect(JSON.stringify(projected.value.item)).toBe(
    JSON.stringify(parsed.commands),
  );
});
