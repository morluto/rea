import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  CPU,
  fatImage,
  machoImage,
} from "../../../../src/artifacts/apple/MachoImage.fixture.js";
import { err, ok } from "../../../../src/domain/result.js";
import {
  NativeCommandFailure,
  type NativeCommandCapture,
  type NativeCommandOptions,
  type NativeCommandRunner,
} from "../../../../src/native/CommandRunner.js";
import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import { parseOtoolLoadCommands } from "../../../../src/native/parsers/otool.js";
import { parseDyldSymbols } from "../../../../src/native/parsers/dyldInfo.js";
import {
  NativeFixtureRunner as FixtureRunner,
  nativeFixture as fixture,
  nativeMachoTarget as machoTarget,
  nativeMachoTargetForFile,
} from "../../../fixtures/nativeCommands.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

const signatureTarget = async (
  signedArchitecture: "arm64" | "arm64e" = "arm64",
) => {
  const path = join(
    await createTestTempDirectory("rea-native-inventory-"),
    "fixture",
  );
  await writeFile(
    path,
    fatImage(
      [CPU.x86_64, CPU[signedArchitecture]].map((cpu) => ({
        cpu,
        bytes: machoImage({ cpu }),
      })),
    ),
  );
  return nativeMachoTargetForFile(path);
};

it("distinguishes a codesign execution failure from an observed unsigned artifact", async () => {
  for (const kind of ["missing", "unsigned"] as const) {
    const client = new NativeMacOSProvider(
      {},
      new FixtureRunner(
        {
          codesign: await fixture(`dyld-inventory/codesign-${kind}.txt`),
        },
        1,
      ),
      "darwin",
    ).createClient(await signatureTarget());
    const execution = await client.execute("inspect_signature", {});
    if (kind === "missing")
      expect(execution).toMatchObject({
        ok: false,
        error: { _tag: "ProviderAdapterError" },
      });
    else {
      expect(execution.ok).toBe(true);
      if (execution.ok)
        expect(execution.value.result).toMatchObject({ signed: false });
    }
  }
});

it("reports unsigned slices when a universal Mach-O has mixed signatures", async () => {
  const signedFixture = await fixture("codesign.txt");
  const unsigned = await fixture("dyld-inventory/codesign-unsigned.txt");
  const entitlements = await fixture("entitlements.xml");
  for (const signedArchitecture of ["arm64", "arm64e"] as const) {
    const signed = signedFixture.replace(
      /^Format=.*$/mu,
      `Format=Mach-O universal (x86_64 ${signedArchitecture})`,
    );
    const client = new NativeMacOSProvider(
      {},
      signatureRunner({ signed, unsigned, entitlements }),
      "darwin",
    ).createClient(await signatureTarget(signedArchitecture));

    const execution = await client.execute("inspect_signature", {});

    expect(execution.ok).toBe(true);
    if (!execution.ok) continue;
    expect(execution.value.result).toMatchObject({
      signed: true,
      identifier: "com.example.fixture",
      designated_requirement: null,
      entitlements: { "com.apple.security.app-sandbox": true },
      limitations: expect.arrayContaining([
        "Unsigned Mach-O slices: x86_64.",
        "The aggregate designated requirement is unavailable because Mach-O slices have mixed signing states.",
      ]),
      provenance: expect.arrayContaining([
        expect.objectContaining({
          command: [
            "/usr/bin/codesign",
            "-d",
            "-a",
            "x86_64",
            "--verbose=4",
            "$ARTIFACT",
          ],
          exit: { code: 1, signal: null },
        }),
        expect.objectContaining({
          command: expect.arrayContaining(["-a", signedArchitecture]),
          exit: { code: 0, signal: null },
        }),
      ]),
    });
  }
});

it("rejects nonzero supplemental codesign output that is not an unsigned observation", async () => {
  const signed = await fixture("codesign.txt");
  const entitlements = await fixture("entitlements.xml");
  const client = new NativeMacOSProvider(
    {},
    signatureRunner({
      signed,
      unsigned: "/private/fixture: invalid or unsupported format\n",
      entitlements,
    }),
    "darwin",
  ).createClient(await signatureTarget());

  const execution = await client.execute("inspect_signature", {});

  expect(execution).toMatchObject({
    ok: false,
    error: { _tag: "ProviderAdapterError" },
  });
});

it("retains native inventory facts from captured Apple tool output", async () => {
  const outputs: Record<string, string> = {};
  for (const tool of ["file", "lipo", "otool", "nm", "dwarfdump", "vtool"])
    outputs[tool] = await fixture(`dyld-inventory/${tool}.txt`);
  outputs["dyld_info:-imports"] = await fixture("dyld-inventory/imports.txt");
  const exportsOutput = await fixture("dyld-inventory/exports.txt");
  outputs["dyld_info:-exports"] = exportsOutput;
  const client = new NativeMacOSProvider(
    {},
    new FixtureRunner(outputs),
    "darwin",
  ).createClient(machoTarget("/private/fixture"));
  const execution = await client.execute("inspect_macho", {});
  if (!execution.ok) throw execution.error;
  expect(execution.value.result).toMatchObject({
    imports: {
      items: [
        { name: "_puts", address: null, source: "libSystem" },
        {
          name: "_fixture_weak",
          address: null,
          source: "<weak-def-coalesce>",
        },
      ],
    },
    exports: {
      items: expect.arrayContaining([
        expect.objectContaining({
          name: "_fixture_export",
          address: "0x100000468",
        }),
        expect.objectContaining({
          name: "_fixture_weak",
          address: "0x100000460",
          weak: true,
        }),
        expect.objectContaining({
          name: "_fixture_absolute",
          address: "0x42",
        }),
      ]),
    },
  });
  expect(
    parseDyldSymbols(await fixture("dyld-imports.txt"), "imports"),
  ).toEqual([
    {
      name: "__Block_copy",
      address: null,
      weak: null,
      reexport: null,
      source: "libSystem",
    },
    {
      name: "_objc_bp_assist_cfg_np",
      address: null,
      weak: true,
      reexport: null,
      source: "libSystem",
    },
  ]);
  expect(
    parseDyldSymbols(
      await fixture("dyld-inventory/library-reexports.txt"),
      "exports",
    ),
  ).toEqual([
    {
      name: "__ZNKSt10bad_typeid4whatEv",
      address: null,
      weak: null,
      reexport: true,
      source: "libc++abi",
    },
  ]);
  expect(parseDyldSymbols(exportsOutput, "exports")).toContainEqual({
    name: "_fixture_export",
    address: null,
    weak: null,
    reexport: false,
    source: null,
  });
});

it("retains symbol names containing spaces in dyld inventory rows", () => {
  expect(
    parseDyldSymbols("  0x0000  _entry with space  (from fixture)", "imports"),
  ).toEqual([
    {
      name: "_entry with space",
      address: null,
      weak: null,
      reexport: null,
      source: "fixture",
    },
  ]);
  expect(
    parseDyldSymbols(
      "  offset symbol\n  0x00000348  _entry with space",
      "exports",
      "0x0",
    ),
  ).toEqual([
    {
      name: "_entry with space",
      address: "0x348",
      weak: null,
      reexport: false,
      source: null,
    },
  ]);
  expect(
    parseDyldSymbols("[re-export] _entry with space (from fixture)", "exports"),
  ).toEqual([
    {
      name: "_entry with space",
      address: null,
      weak: null,
      reexport: true,
      source: "fixture",
    },
  ]);
  expect(
    parseDyldSymbols("0x123 _weak with space [weak-def]", "exports"),
  ).toEqual([
    {
      name: "_weak with space",
      address: "0x123",
      weak: true,
      reexport: false,
      source: null,
    },
  ]);
});

it("preserves numeric-looking segment and section identifiers from otool", () => {
  const parsed = parseOtoolLoadCommands(`Load command 1
      cmd LC_SEGMENT_64
  cmdsize 152
  segname 0001
   vmaddr 0x0000000000004000
   vmsize 0x0000000000004000
  fileoff 16384
 filesize 16384
  maxprot 0x00000003
 initprot 0x00000003
   nsects 1
    flags 0x4
Section
  sectname 0002
   segname 0001
      addr 0x0000000000004000
      size 0x0000000000000008
    offset 16384
     align 2^0 (1)
    reloff 0
    nreloc 0
     flags 0x00000000
 reserved1 0
 reserved2 0
`);
  expect(parsed.segments[0]).toMatchObject({
    name: "0001",
    file_offset: 16384,
    sections: [{ segment: "0001", name: "0002", size: 8 }],
  });
});

const signatureRunner = (outputs: {
  readonly signed: string;
  readonly unsigned: string;
  readonly entitlements: string;
}): NativeCommandRunner => ({
  run(
    tool: string,
    arguments_: readonly string[],
    options: NativeCommandOptions,
  ) {
    const architectureIndex = arguments_.indexOf("-a");
    const architecture =
      architectureIndex < 0 ? null : arguments_[architectureIndex + 1];
    const response = arguments_.includes("-r-")
      ? { output: outputs.unsigned, exitCode: 1 }
      : arguments_.includes("--entitlements")
        ? { output: outputs.entitlements, exitCode: 0 }
        : architecture === "x86_64"
          ? { output: outputs.unsigned, exitCode: 1 }
          : { output: outputs.signed, exitCode: 0 };
    const capture: NativeCommandCapture = {
      tool,
      executable: `/usr/bin/${tool}`,
      executableSha256: "a".repeat(64),
      toolVersion: null,
      versionReason: "fixture",
      arguments: [...arguments_],
      // Entitlements XML is printed to stdout; diagnostics to stderr.
      ...(arguments_.includes("--entitlements")
        ? {
            stdout: response.output,
            stderr: "",
            stdoutBytes: Buffer.byteLength(response.output),
            stderrBytes: 0,
          }
        : {
            stdout: "",
            stderr: response.output,
            stdoutBytes: 0,
            stderrBytes: Buffer.byteLength(response.output),
          }),
      exitCode: response.exitCode,
      signal: null,
    };
    return Promise.resolve(
      response.exitCode === 0 || options.acceptNonZero === true
        ? ok(capture)
        : err(
            new NativeCommandFailure(tool, "nonzero-exit", response.exitCode),
          ),
    );
  },
});

it.each([
  "/tmp/Load command 12/plugin.dylib",
  "@rpath/plugin-Load command 34.dylib",
])(
  "keeps load-command-looking text inside native install names: %s",
  (installName) => {
    const parsed = parseOtoolLoadCommands(`Load command 0
          cmd LC_ID_DYLIB
      cmdsize 80
         name ${installName} (offset 24)
   time stamp 2 Thu Jan  1 00:00:02 1970
      current version 3.2.1
compatibility version 1.0.0
Load command 1
          cmd LC_UUID
      cmdsize 24
         uuid 01234567-89AB-CDEF-0123-456789ABCDEF
`);
    expect(parsed.commands.map(({ index, kind }) => ({ index, kind }))).toEqual(
      [
        { index: 0, kind: "LC_ID_DYLIB" },
        { index: 1, kind: "LC_UUID" },
      ],
    );
    expect(parsed.dependencies).toEqual([
      {
        path: installName,
        kind: "LC_ID_DYLIB",
        current_version: "3.2.1",
        compatibility_version: "1.0.0",
      },
    ]);
    expect(parsed.uuid).toBe("01234567-89AB-CDEF-0123-456789ABCDEF");
  },
);
it.each(["weak-def", "absolute", "literal suffix"])(
  "preserves an nm-proven export name ending in [%s]",
  (suffix) => {
    const name = `symbol [${suffix}]`;
    expect(
      parseDyldSymbols(
        `offset symbol\n0x120 ${name}`,
        "exports",
        "0x1000",
        new Set([name]),
      ),
    ).toEqual([
      { name, address: "0x1120", weak: null, reexport: false, source: null },
    ]);
  },
);

it("keeps true weak annotations when nm establishes the unannotated name", () => {
  expect(
    parseDyldSymbols(
      "0x120 _weak [weak-def]",
      "exports",
      null,
      new Set(["_weak"]),
    ),
  ).toEqual([
    {
      name: "_weak",
      address: "0x120",
      weak: true,
      reexport: false,
      source: null,
    },
  ]);
});

it("leaves an ambiguous short and literal name to the caller's nm inventory", () => {
  expect(
    parseDyldSymbols(
      "0x120 symbol [weak-def]",
      "exports",
      null,
      new Set(["symbol", "symbol [weak-def]"]),
    ),
  ).toEqual([]);
});

it("retains annotation parsing without nm name evidence", () => {
  expect(parseDyldSymbols("0x120 _weak [weak-def]", "exports")).toEqual([
    {
      name: "_weak",
      address: "0x120",
      weak: true,
      reexport: false,
      source: null,
    },
  ]);
});
