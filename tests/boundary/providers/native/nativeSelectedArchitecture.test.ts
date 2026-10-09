import { expect, it } from "vitest";
import { inspectMachoSchema } from "../../../../src/domain/native/nativeInspection.js";
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
    {},
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
  if (!result.ok) throw result.error;
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
      {},
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

    if (!result.ok) throw result.error;
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

it("projects universal segment evidence into the selected slice's container offsets", async () => {
  const client = new NativeMacOSProvider(
    {},
    new NativeFixtureRunner(),
    "darwin",
  ).createClient(nativeMachoTarget("/owned/universal"));
  const result = await client.execute("inspect_macho", {});
  if (!result.ok) throw result.error;
  expect(result.value.locations).toContainEqual({
    kind: "file-offset-range",
    start: 32768,
    end: 40960,
  });
  expect(result.value.locations).not.toContainEqual({
    kind: "file-offset-range",
    start: 0,
    end: 8192,
  });
  // The normalized tool field remains slice-relative; only evidence is projected.
  expect(
    inspectMachoSchema.parse(result.value.result).segments.items[0]
      ?.file_offset,
  ).toBe(0);
});

it.each([
  {
    description: "thin",
    lipo: "Non-fat file: /owned/input is architecture: arm64\n",
    offset: 0,
  },
  {
    description: "one-slice FAT",
    lipo: "architecture arm64\n offset 16384\n size 8192\n align 2^14 (16384)\n",
    offset: 16384,
  },
])(
  "keeps $description segment evidence in the input file's coordinate system",
  async ({ lipo, offset }) => {
    const base = nativeMachoTarget("/owned/input");
    if (base.kind !== "executable")
      throw new Error("Expected executable fixture");
    const target = { ...base, availableArchitectures: ["arm64"] as const };
    const result = await new NativeMacOSProvider(
      {},
      new NativeFixtureRunner({ lipo }),
      "darwin",
    )
      .createClient(target)
      .execute("inspect_macho", {});
    if (!result.ok) throw result.error;
    expect(result.value.locations).toContainEqual({
      kind: "file-offset-range",
      start: offset,
      end: offset + 8192,
    });
    if (offset > 0)
      expect(result.value.locations).not.toContainEqual({
        kind: "file-offset-range",
        start: 0,
        end: 8192,
      });
  },
);

it.each([
  {
    lipo: "architecture x86_64\n offset 16384\n size 8192\narchitecture arm64\n size 8192\n",
    availableArchitectures: ["x86_64", "arm64"] as const,
  },
  {
    lipo: "architecture arm64\n size 8192\n",
    availableArchitectures: ["arm64"] as const,
  },
])(
  "does not invent a container offset when the selected slice has no observed offset ($availableArchitectures)",
  async ({ lipo, availableArchitectures }) => {
    const base = nativeMachoTarget("/owned/universal");
    if (base.kind !== "executable")
      throw new Error("Expected executable fixture");
    const result = await new NativeMacOSProvider(
      {},
      new NativeFixtureRunner({ lipo }),
      "darwin",
    )
      .createClient({ ...base, availableArchitectures })
      .execute("inspect_macho", {});
    if (!result.ok) throw result.error;
    expect(result.value.locations).not.toContainEqual({
      kind: "file-offset-range",
      start: 0,
      end: 8192,
    });
    expect(result.value.limitations).toContain(
      "Segment evidence file offsets are unavailable because the selected Mach-O slice's container offset was not observed.",
    );
  },
);
