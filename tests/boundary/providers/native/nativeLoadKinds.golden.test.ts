import { expect, it } from "vitest";

import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import { parseOtoolLoadCommands } from "../../../../src/native/parsers/otool.js";
import {
  NativeFixtureRunner,
  nativeMachoTarget,
} from "../../../fixtures/nativeCommands.js";

it("retains lazily loaded library dependencies", () => {
  const load = parseOtoolLoadCommands(
    [
      "Load command 9",
      "      cmd LC_LAZY_LOAD_DYLIB",
      "      name /usr/lib/libLazy.dylib (offset 24)",
      "   time stamp 2 Thu Jan  1 00:00:02 1970",
      "      current version 1.0.0",
      "compatibility version 1.0.0",
      "",
    ].join("\n"),
  );
  expect(load.dependencies).toContainEqual({
    path: "/usr/lib/libLazy.dylib",
    kind: "LC_LAZY_LOAD_DYLIB",
    current_version: "1.0.0",
    compatibility_version: "1.0.0",
  });
});

it("normalizes legacy version-minimum commands into build metadata", () => {
  const load = parseOtoolLoadCommands(
    [
      "Load command 3",
      "      cmd LC_VERSION_MIN_MACOSX",
      "    version 10.13",
      "        sdk 10.15",
      "Load command 4",
      "      cmd LC_VERSION_MIN_IPHONEOS",
      "    version 12.0",
      "        sdk 12.1",
      "Load command 5",
      "      cmd LC_SOURCE_VERSION",
      "    version 1.2.3",
      "",
    ].join("\n"),
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

it("limits thread-state entrypoints instead of reporting none silently", async () => {
  const runner = new NativeFixtureRunner({
    "otool:-h": [
      "Load command 0",
      "      cmd LC_UNIXTHREAD",
      "      flavor 1",
      "      count 1",
      "",
    ].join("\n"),
  });
  const client = new NativeMacOSProvider(runner, "darwin").createClient(
    nativeMachoTarget("/owned/legacy-fixture"),
  );
  const result = await client.execute("inspect_macho", {});
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.result).toMatchObject({
    entrypoints: { items: [] },
  });
  expect(result.value.limitations).toContain(
    "Thread-state entrypoints (LC_UNIXTHREAD/LC_THREAD) are retained as raw load commands; file offsets are not derived.",
  );
});
