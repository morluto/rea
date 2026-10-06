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
