import { expect, it } from "vitest";
import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import { parseDyldSymbols } from "../../../../src/native/parsers/dyldInfo.js";
import {
  NativeFixtureRunner as FixtureRunner,
  nativeFixture as fixture,
  nativeMachoTarget as machoTarget,
} from "../../../fixtures/nativeCommands.js";

it("distinguishes a codesign execution failure from an observed unsigned artifact", async () => {
  for (const kind of ["missing", "unsigned"] as const) {
    const client = new NativeMacOSProvider(
      new FixtureRunner(
        {
          codesign: await fixture(`dyld-inventory/codesign-${kind}.txt`),
        },
        1,
      ),
      "darwin",
    ).createClient(machoTarget("/private/fixture"));
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

it("retains native inventory facts from captured Apple tool output", async () => {
  const outputs: Record<string, string> = {};
  for (const tool of ["file", "lipo", "otool", "nm", "dwarfdump", "vtool"])
    outputs[tool] = await fixture(`dyld-inventory/${tool}.txt`);
  outputs["dyld_info:-imports"] = await fixture("dyld-inventory/imports.txt");
  const exportsOutput = await fixture("dyld-inventory/exports.txt");
  outputs["dyld_info:-exports"] = exportsOutput;
  const client = new NativeMacOSProvider(
    new FixtureRunner(outputs),
    "darwin",
  ).createClient(machoTarget("/private/fixture"));
  const execution = await client.execute("inspect_macho", {});
  expect(execution.ok).toBe(true);
  if (!execution.ok) return;
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
