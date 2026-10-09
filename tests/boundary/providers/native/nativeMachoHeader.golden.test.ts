import { expect, it } from "vitest";

import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import { parseOtoolLoadCommands } from "../../../../src/native/parsers/otool.js";
import {
  NativeFixtureRunner,
  nativeFixture,
  nativeMachoTarget,
} from "../../../fixtures/nativeCommands.js";

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
      " flags filetype magic cputype",
      " NOUNDEFS 2 0xfeedfacf 16777228",
      "Load command 0",
      " cmd LC_UUID",
      " uuid 01234567-89ab-cdef-0123-456789abcdef",
    ].join("\n"),
  );
  expect(reordered.fileType).toBe("2");
  expect(reordered.flags).toEqual(["NOUNDEFS"]);
  const reorderedMultiwordFlags = parseOtoolLoadCommands(
    [
      "Mach header",
      " filetype magic flags ncmds sizeofcmds",
      " 2 0xfeedfacf NOUNDEFS DYLDLINK 4 512",
    ].join("\n"),
  );
  expect(reorderedMultiwordFlags.fileType).toBe("2");
  expect(reorderedMultiwordFlags.flags).toEqual(["DYLDLINK", "NOUNDEFS"]);
  const missing = parseOtoolLoadCommands(
    "Mach header\n magic cputype flags\n 0xfeedfacf 1 NOUNDEFS\n",
  );
  expect(missing.fileType).toBeNull();
  expect(missing.flags).toEqual(["NOUNDEFS"]);
  const incomplete = parseOtoolLoadCommands(
    "Mach header\n filetype magic flags ncmds sizeofcmds\n 2 0xfeedfacf NOUNDEFS\n",
  );
  expect(incomplete.fileType).toBeNull();
  expect(incomplete.flags).toEqual([]);
});
