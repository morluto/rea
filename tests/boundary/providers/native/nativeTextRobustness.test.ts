import { expect, it } from "vitest";

import { parseOtoolLoadCommands } from "../../../../src/native/parsers/otool.js";
import { parsePlistJson } from "../../../../src/native/parsers/plist.js";
import { parseLipoArchitectures } from "../../../../src/native/parsers/lipo.js";
import { nativeFixture } from "../../../fixtures/nativeCommands.js";

const toCrlf = (value: string): string => value.replaceAll("\n", "\r\n");

it.each([
  "line\nbreak",
  "line\r\nbreak",
  "name is architecture: x86_64\ncontinued",
])(
  "retains the reported thin architecture when lipo echoes filename %j",
  (filename) => {
    const output = `input file /owned/${filename} is not a fat file\nNon-fat file: /owned/${filename} is architecture: arm64\n`;
    expect(parseLipoArchitectures(output)).toMatchObject([{ name: "arm64" }]);
  },
);

it("does not mistake fat slice output for a thin Non-fat file record", () => {
  const output = [
    "Fat header in: /owned/universal.dylib",
    "fat_magic 0xcafebab2",
    "nfat_arch 2",
    "architecture arm64",
    "    cputype CPU_TYPE_ARM64",
    "    cpusubtype CPU_SUBTYPE_ARM64E",
    "    offset 16384",
    "    size 16777216",
    "    align 2^14 (16384)",
    "architecture x86_64",
    "    cputype CPU_TYPE_X86_64",
    "    cpusubtype CPU_SUBTYPE_X86_64_ALL",
    "    offset 16793600",
    "    size 16777216",
    "    align 2^12 (4096)",
    "",
  ].join("\n");
  expect(parseLipoArchitectures(output)).toMatchObject([
    { name: "arm64", file_offset: 16384 },
    { name: "x86_64", file_offset: 16793600 },
  ]);
});

it("keeps section blocks separate under CRLF captures", async () => {
  const lf = parseOtoolLoadCommands(await nativeFixture("otool-load.txt"));
  const crlf = parseOtoolLoadCommands(
    toCrlf(await nativeFixture("otool-load.txt")),
  );
  expect(crlf.segments).toMatchObject(lf.segments);
  const crlfText = crlf.segments.find(({ name }) => name === "__TEXT");
  expect(crlfText?.sections.length).toBeGreaterThan(0);
  expect(crlfText?.sections.map(({ name }) => name)).toContain("__text");
});

it("does not leak section fields into command fields under CRLF captures", async () => {
  const crlf = parseOtoolLoadCommands(
    toCrlf(await nativeFixture("otool-load.txt")),
  );
  const segment = crlf.commands.find(
    (command) => command.kind === "LC_SEGMENT_64",
  );
  expect(segment?.fields.sectname).toBeUndefined();
  expect(segment?.fields["time stamp"]).toBeUndefined();
});

it("accepts a byte-order mark before plist JSON", () => {
  const parsed = parsePlistJson(
    '\uFEFF{"CFBundleIdentifier":"com.owned.fixture"}',
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error("expected plist JSON to parse");
  expect(parsed.value.bundle.identifier).toBe("com.owned.fixture");
});
