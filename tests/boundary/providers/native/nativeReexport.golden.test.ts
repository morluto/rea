import { expect, it } from "vitest";

import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import {
  NativeFixtureRunner,
  nativeFixture,
  nativeMachoTarget,
} from "../../../fixtures/nativeCommands.js";

it("retains native re-export dependencies alongside ordinary and identity commands", async () => {
  const runner = new NativeFixtureRunner({
    otool: await nativeFixture("native-reexport/otool-load.txt"),
  });
  const client = new NativeMacOSProvider(runner, "darwin").createClient(
    nativeMachoTarget("/owned/libOuter.dylib"),
  );
  const result = await client.execute("inspect_macho", {});
  if (!result.ok) throw result.error;
  expect(result.value.result).toMatchObject({
    dependencies: {
      exhaustive: true,
      total: 3,
      items: expect.arrayContaining([
        expect.objectContaining({
          kind: "LC_REEXPORT_DYLIB",
          path: "@rpath/libLeaf.dylib",
        }),
        expect.objectContaining({
          kind: "LC_ID_DYLIB",
          path: "/owned/libOuter.dylib",
        }),
        expect.objectContaining({
          kind: "LC_LOAD_DYLIB",
          path: "/usr/lib/libSystem.B.dylib",
        }),
      ]),
    },
  });
});
