import { expect, it } from "vitest";
import { CPU } from "../../../../src/artifacts/apple/MachoImage.fixture.js";
import { inspectMachoSchema } from "../../../../src/domain/native/nativeInspection.js";
import { err } from "../../../../src/domain/result.js";
import {
  NativeCommandFailure,
  type NativeCommandRunner,
} from "../../../../src/native/CommandRunner.js";
import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import {
  NativeFixtureRunner,
  nativeFixture,
  nativeMachoTarget,
} from "../../../fixtures/nativeCommands.js";

/** Replay fixtures, failing any slice command that does not name the expected slice. */
const sliceSelectingRunner = (
  fixtures: NativeFixtureRunner,
  selected: string,
  dyldArchitecture: string,
  calls: {
    readonly tool: string;
    readonly arguments_: readonly string[];
  }[] = [],
): NativeCommandRunner => ({
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
});

it("does not attribute the first universal slice's UUID and segments to the selected target", async () => {
  const singleSlice = await nativeFixture("otool-load.txt");
  const selected = new NativeFixtureRunner();
  const universal = new NativeFixtureRunner({
    "otool:-h": `${singleSlice}\n${singleSlice}`,
    dwarfdump:
      "UUID: AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA (x86_64) /owned/universal\nUUID: 01234567-89AB-CDEF-0123-456789ABCDEF (arm64) /owned/universal\n",
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
    selected_architecture: {
      name: "arm64",
      container_file_offset: 32768,
    },
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
  {
    architectures: ["arm64v8", "arm64e.v1"],
    selected: "arm64e",
    dyldArchitecture: "arm64e.v1",
  },
  {
    architectures: ["arm64e.v1", "arm64v8"],
    selected: "arm64e",
    dyldArchitecture: "arm64e.v1",
  },
] as const)(
  "selects the $dyldArchitecture slice of a universal arm64e target",
  async ({ architectures, selected, dyldArchitecture }) => {
    const calls: {
      readonly tool: string;
      readonly arguments_: readonly string[];
    }[] = [];
    const cpus = {
      x86_64: CPU.x86_64,
      arm64e: CPU.arm64e,
      arm64v8: { type: CPU.arm64.type, subtype: 1 },
      "arm64e.x1": { type: CPU.arm64.type, subtype: 0x8000000c },
      "arm64e.v1": { type: CPU.arm64.type, subtype: 0x81000002 },
    };
    const lipo = architectures
      .map((architecture, index) => {
        const cpu = cpus[architecture];
        const subtype =
          architecture === "arm64e.v1"
            ? "CPU_SUBTYPE_ARM64E\n    capabilities PTR_AUTH_VERSION USERSPACE 1"
            : String(cpu.subtype);
        return `architecture ${architecture}\n    cputype ${cpu.type}\n    cpusubtype ${subtype}\n    offset ${index * 16384}\n    size 8192\n    align 2^14 (16384)`;
      })
      .join("\n");
    const fixtures = new NativeFixtureRunner({
      lipo,
      dwarfdump: `UUID: 01234567-89AB-CDEF-0123-456789ABCDEF (${dyldArchitecture}) /owned/universal\n`,
    });
    const client = new NativeMacOSProvider(
      {},
      sliceSelectingRunner(fixtures, selected, dyldArchitecture, calls),
      "darwin",
    ).createClient(nativeMachoTarget("/owned/universal"));

    const result = await client.execute("inspect_macho", {});

    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({
      uuid: "01234567-89AB-CDEF-0123-456789ABCDEF",
      selected_architecture: {
        name: dyldArchitecture,
        container_file_offset:
          architectures.findIndex((name) => name === dyldArchitecture) * 16384,
      },
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

it.each([
  { capture: "calculator.txt", selected: "arm64e" },
  { capture: "shortcut-droplet.txt", selected: "arm64" },
])(
  "selects one slice when every universal slice has the target's CPU type ($capture)",
  async ({ capture, selected }) => {
    const base = nativeMachoTarget("/owned/universal");
    if (base.kind !== "executable")
      throw new Error("Expected executable fixture");
    // Admission names arm64, arm64e and arm64e.x1 slices by one CPU family.
    const target = { ...base, availableArchitectures: ["arm64"] as const };
    const fixtures = new NativeFixtureRunner({
      lipo: await nativeFixture(`lipo-same-cpu/${capture}`),
    });
    const result = await new NativeMacOSProvider(
      {},
      sliceSelectingRunner(fixtures, selected, selected),
      "darwin",
    )
      .createClient(target)
      .execute("inspect_macho", {});

    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({
      selected_architecture: { name: selected, container_file_offset: 16384 },
      architectures: { total: 2 },
    });
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
  expect(result.value.locations).toContainEqual({
    kind: "file-offset",
    offset: 36864,
  });
  expect(result.value.locations).not.toContainEqual({
    kind: "file-offset-range",
    start: 0,
    end: 8192,
  });
  // Normalized tool fields keep their slice-relative meaning.
  const normalized = inspectMachoSchema.parse(result.value.result);
  expect(normalized.segments.items[0]?.file_offset).toBe(0);
  expect(normalized.entrypoints.items[0]?.file_offset).toBe(4096);
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
    expect(result.value.result).toMatchObject({
      selected_architecture: {
        name: "arm64",
        container_file_offset: offset,
      },
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
      "The selected Mach-O slice's container file offset was not observed; slice-based evidence locations are unavailable.",
    );
    expect(result.value.result).toMatchObject({
      selected_architecture: { container_file_offset: null },
    });
  },
);
