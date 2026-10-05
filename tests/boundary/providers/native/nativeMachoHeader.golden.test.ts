import { expect, it } from "vitest";

import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import { parseOtoolLoadCommands } from "../../../../src/native/parsers/otool.js";
import {
  NativeFixtureRunner,
  nativeFixture,
  nativeMachoTarget,
} from "../../../fixtures/nativeCommands.js";

it("collects the actual Mach header alongside the native load commands", async () => {
  const runner = new NativeFixtureRunner({
    otool: await nativeFixture("native-macho-header/otool-load.txt"),
    "otool:-h": await nativeFixture("native-macho-header/otool-header-load.txt"),
  });
  const client = new NativeMacOSProvider(runner, "darwin").createClient(
    nativeMachoTarget("/owned/fixture"),
  );
  const result = await client.execute("inspect_macho", {});
  expect(result.ok).toBe(true);
  if (!result.ok) return;
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
  expect(load.commands.some((command) => command.fields.flags === 0)).toBe(true);
});
