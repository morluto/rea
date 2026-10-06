import { expect, it } from "vitest";
import { inspectMachoSchema } from "../../../../src/domain/nativeInspection.js";
import { err } from "../../../../src/domain/result.js";
import { NativeCommandFailure } from "../../../../src/native/CommandRunner.js";
import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import {
  NativeFixtureRunner,
  nativeFixture,
  nativeMachoTarget,
} from "../../../fixtures/nativeCommands.js";

it("does not attribute the first universal slice's UUID and segments to the selected target", async () => {
  const singleSlice = await nativeFixture("otool-load.txt");
  const selected = new NativeFixtureRunner();
  const universal = new NativeFixtureRunner({
    "otool:-h": `${singleSlice}\n${singleSlice}`,
    dwarfdump:
      "UUID: AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA (x86_64) fixture\nUUID: 01234567-89AB-CDEF-0123-456789ABCDEF (arm64) fixture\n",
  });
  const client = new NativeMacOSProvider(
    {
      async run(tool, arguments_) {
        const isSelected =
          arguments_.includes("arm64") || arguments_.includes("--arch=arm64");
        return (isSelected ? selected : universal).run(tool, arguments_);
      },
    },
    "darwin",
  ).createClient(nativeMachoTarget("/owned/universal"));
  const result = await client.execute("inspect_macho", {});
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.result).toMatchObject({
    uuid: "01234567-89AB-CDEF-0123-456789ABCDEF",
    architectures: { total: 2 },
  });
  const normalized = inspectMachoSchema.parse(result.value.result);
  expect(
    normalized.segments.items.filter((segment) => segment.name === "__TEXT"),
  ).toHaveLength(1);
  expect(JSON.stringify(normalized)).not.toContain(
    "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
  );
});

it.each([
  {
    architectures: ["x86_64", "arm64e", "arm64e.x1"],
    selected: "arm64e",
    dyldArchitecture: "arm64e",
  },
  {
    architectures: ["x86_64", "arm64e.v1"],
    selected: "arm64e",
    dyldArchitecture: "arm64e.v1",
  },
])(
  "selects the $dyldArchitecture slice of a universal arm64e target",
  async ({ architectures, selected, dyldArchitecture }) => {
    const calls: {
      readonly tool: string;
      readonly arguments_: readonly string[];
    }[] = [];
    const lipo = architectures
      .map(
        (architecture, index) =>
          `architecture ${architecture}\n    cputype 16777228\n    cpusubtype 2\n    offset ${index * 16384}\n    size 8192\n    align 2^14 (16384)`,
      )
      .join("\n");
    const fixtures = new NativeFixtureRunner({
      lipo,
      dwarfdump: `UUID: 01234567-89AB-CDEF-0123-456789ABCDEF (${dyldArchitecture}) fixture\n`,
    });
    const client = new NativeMacOSProvider(
      {
        run(tool, arguments_) {
          calls.push({ tool, arguments_ });
          const expected = tool === "dyld_info" ? dyldArchitecture : selected;
          if (
            !["file", "lipo"].includes(tool) &&
            !arguments_.some(
              (argument, index) =>
                argument === expected ||
                argument === `--arch=${expected}` ||
                (argument === "-arch" && arguments_[index + 1] === expected),
            )
          )
            return Promise.resolve(
              err(new NativeCommandFailure(tool, "nonzero-exit", 1)),
            );
          return fixtures.run(tool, arguments_);
        },
      },
      "darwin",
    ).createClient(nativeMachoTarget("/owned/universal"));

    const result = await client.execute("inspect_macho", {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result).toMatchObject({
      uuid: "01234567-89AB-CDEF-0123-456789ABCDEF",
      architectures: {
        items: architectures.map((name) => ({ name })),
      },
    });
    expect(
      calls
        .filter(({ tool }) => tool === "dyld_info")
        .every(({ arguments_ }) => arguments_.includes(dyldArchitecture)),
    ).toBe(true);
  },
);
