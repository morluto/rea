import { describe, expect, it } from "vitest";

import { parseConfig } from "../config/parseConfig.js";
import type {
  BinaryTarget,
  RawBinaryLoad,
} from "../domain/binaryTargetTypes.js";
import {
  ARCHITECTURE_VARIANT_NAMES,
  type ArchitectureVariant,
} from "../domain/architectureVariant.js";
import {
  admittedRawLoad,
  vectorTableWords,
} from "../domain/rawBinary.fixture.js";
import { GHIDRA_VARIANT_LANGUAGES } from "./GhidraRawBinaryLanguage.js";
import { silentLogger } from "../logger.js";
import { ghidraProfileInstallationHost as host } from "./GhidraInstallation.fixture.js";
import { GhidraProvider } from "./GhidraProvider.js";

// Digests commit to the current shared policy, including the instruction
// status, load-image relocation-symbol, procedure search, byte-search and
// bit-field base-type and inventory-search revisions that prevent reuse of snapshots with earlier
// results.
const RAW_DIGESTS = {
  "6502": "a4852d16c3239bce7ac9182977ea56864bfcb4319fa38750947be5e2cb0e9ea4",
  "x86-disabled-analyzer":
    "cf72eabf031fcf1f082fb87a5cbcd7285a01f4ca5368952d0bd3f57c4db1f87a",
} as const;

// Computed by upstream main at f912a6841, which has neither a separate base nor
// a variant. A raw load whose base is its caller-selected entry keeps these
// profile digests, so it stays reusable wherever main's raw sessions and
// snapshots are.
const LEGACY_RAW_DIGESTS = [
  [
    "x86",
    "0x1000",
    "e2fc3fe0a4e72c52ef13517c484a86d9fe7a2fec1d19ffe6f16f690e51eb9f65",
  ],
  [
    "x86_64",
    "0x401000",
    "6fa9d37970f92b4906d7e4a6636a4f48af4cec0c1f7a8a7d7011e903031b5aa0",
  ],
  [
    "arm",
    "0x8000000",
    "1f1863d57353467a208bde81e85bde66bd2c2eb79814d108ef5d66d66a716cde",
  ],
  [
    "arm64",
    "0x80000",
    "90fef97f9adc6b85fa6a1849d25ed87e005108e4098a38eb16c6d48cabb80372",
  ],
  [
    "m68k",
    "0x1000",
    "502b3cab47e3e341d8f6e3611634bc2f46f8d1d1f2427fce341a1e42bfe8e2ec",
  ],
] as const;

const configFor = (environment: NodeJS.ProcessEnv) => {
  const parsed = parseConfig({ GHIDRA_INSTALL_DIR: "/ghidra", ...environment });
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};

const raw = (
  architecture: Extract<BinaryTarget, { format: "raw-binary" }>["architecture"],
  entryPoint: string,
): BinaryTarget => ({
  path: "/tmp/raw.bin",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "raw-binary",
  architecture,
  availableArchitectures: [architecture],
  rawLoad: {
    baseAddress: entryPoint,
    entryPoint,
    entrySource: { kind: "caller" },
  },
});

describe("raw-binary analysis profile digest", () => {
  it("commits the 6502 raw profile to the current shared policy", async () => {
    const ghidra = new GhidraProvider(configFor({}), silentLogger, {}, host);
    const resolved = await ghidra.resolveAnalysisProfile(raw("6502", "0x8001"));
    if (!resolved.ok) throw resolved.error;
    expect(resolved.value.profile?.digest).toBe(RAW_DIGESTS["6502"]);
    expect(resolved.value.profile?.parameters).toMatchObject({
      target_format: "raw-binary",
      loader: "BinaryLoader",
      language_id: "6502:LE:16:default",
      language_selection: "caller-supplied-v1",
      load_image_evidence: "independent-raw-mapping-context-v4",
      load_image_observations:
        "source-mappings-entry-context-relocation-symbol-v3",
      instruction_status: "unlisted-address-without-decode-v1",
      inventory_search_projection: "provider-inventory-facts-v1",
      byte_search_boundary: "contiguous-eligible-initialized-blocks-v1",
      data_type_observations: "bit-field-base-and-lookup-v1",
      analyzer_preset: "ghidra-default",
    });
  });

  it("keeps the disabled-analyzer raw digest and its analysis options", async () => {
    const ghidra = new GhidraProvider(
      configFor({
        REA_GHIDRA_DISABLED_ANALYZERS: "Aggressive Instruction Finder",
      }),
      silentLogger,
      {},
      host,
    );
    const resolved = await ghidra.resolveAnalysisProfile(raw("x86", "0x1000"));
    if (!resolved.ok) throw resolved.error;
    expect(resolved.value.profile?.digest).toBe(
      RAW_DIGESTS["x86-disabled-analyzer"],
    );
    expect(resolved.value.profile?.parameters).toMatchObject({
      inventory_search_projection: "provider-inventory-facts-v1",
      analysis_options: {
        disabled_analyzers: ["Aggressive Instruction Finder"],
      },
    });
  });

  it.each(LEGACY_RAW_DIGESTS)(
    "keeps the %s raw profile digest at entry %s",
    async (architecture, entryPoint, digest) => {
      const ghidra = new GhidraProvider(configFor({}), silentLogger, {}, host);
      const resolved = await ghidra.resolveAnalysisProfile(
        raw(architecture, entryPoint),
      );
      if (!resolved.ok) throw resolved.error;
      expect(resolved.value.profile?.parameters).toMatchObject({
        entry_point: entryPoint,
      });
      expect(resolved.value.profile?.digest).toBe(digest);
    },
  );
});

describe("M-profile raw-binary analysis profile", () => {
  const ghidra = () =>
    new GhidraProvider(configFor({}), silentLogger, {}, host);
  const profile = async (rawLoad: RawBinaryLoad) => {
    const resolved = await ghidra().resolveAnalysisProfile({
      path: "/tmp/raw.bin",
      sha256: "a".repeat(64),
      kind: "executable",
      format: "raw-binary",
      architecture: "arm",
      availableArchitectures: ["arm"],
      rawLoad,
    });
    if (!resolved.ok) throw resolved.error;
    if (resolved.value.profile === null) throw new Error("expected a profile");
    return resolved.value.profile;
  };
  const reset = (
    variant: ArchitectureVariant,
    selection: { baseAddress?: string; vectorTableAddress?: string } = {},
  ) =>
    admittedRawLoad(
      {
        architecture: "arm",
        architectureVariant: variant,
        entryPoint: undefined,
        baseAddress: "0x08000000",
        ...selection,
        fileBytes: 0x200,
      },
      vectorTableWords(0x20005000, 0x080001c5),
    );

  it("keeps the legacy ARM digest for a load admitted without a variant", async () => {
    const legacy = await profile(
      admittedRawLoad({
        architecture: "arm",
        entryPoint: "0x08000000",
        fileBytes: 4,
      }),
    );
    expect(legacy.digest).toBe(
      LEGACY_RAW_DIGESTS.find(([family]) => family === "arm")?.[2],
    );
    expect(legacy.parameters).not.toHaveProperty("raw_load");
  });

  it.each(ARCHITECTURE_VARIANT_NAMES)(
    "commits the %s decoder, Thumb entry context and raw_load",
    async (variant) => {
      const committed = await profile(reset(variant));
      expect(committed.parameters).toMatchObject({
        language_id: GHIDRA_VARIANT_LANGUAGES[variant],
        compiler_spec_id: "default",
        load_image_evidence: "independent-raw-segments-v1",
        entry_context: "thumb-tmode-1-before-analysis-v1",
        processor_labels: "not-applied-v1",
        raw_load: {
          version: 1,
          base_address: "0x8000000",
          architecture_variant: variant,
          vector_table_address: "0x8000000",
          entries: [
            {
              address: "0x80001c4",
              isa_mode: "thumb",
              role: "reset",
              basis: "vector-table",
            },
          ],
        },
      });
      // raw_load holds the base and entry; flat copies would only repeat it.
      expect(committed.parameters).not.toHaveProperty("entry_point");
      expect(committed.parameters).not.toHaveProperty("base_address");
    },
  );

  it("keeps the digest across spellings and provenance only", async () => {
    const digest = (await profile(reset("armv7-m"))).digest;
    // Pinned so a change to raw_load semantics must bump its version.
    expect(digest).toBe(
      "42e71fe005ef4afc6c80c742213596071ab768ff16841051b73500565e73e654",
    );
    expect(
      (await profile(reset("armv7-m", { baseAddress: "0x8000000" }))).digest,
    ).toBe(digest);
    expect(
      (await profile(reset("armv7-m", { vectorTableAddress: "0x08000000" })))
        .digest,
    ).toBe(digest);
  });

  it("gives every entry of one image one coordinate context", async () => {
    const derived = await profile(reset("armv7-m"));
    const named = (entryPoint: string) =>
      profile(
        admittedRawLoad({
          architecture: "arm",
          architectureVariant: "armv7-m",
          baseAddress: "0x8000000",
          entryPoint,
          fileBytes: 0x200,
        }),
      );
    // Session identity covers the entry and its basis; coordinates do not.
    for (const other of [await named("0x80001c4"), await named("0x8000100")]) {
      expect(other.digest).not.toBe(derived.digest);
      expect(other.parameters.function_coordinate_context).toEqual(
        derived.parameters.function_coordinate_context,
      );
    }
  });

  it("separates base, variant and vector table", async () => {
    const base = await profile(reset("armv7-m"));
    const coordinates = (committed: typeof base) =>
      committed.parameters.function_coordinate_context;
    const movedBase = await profile(
      admittedRawLoad(
        {
          architecture: "arm",
          architectureVariant: "armv7-m",
          entryPoint: undefined,
          baseAddress: "0x07ffff00",
          fileBytes: 0x400,
        },
        vectorTableWords(0x20005000, 0x080001c5),
      ),
    );
    const v8m = await profile(reset("armv8-m.main"));
    // Same base and decoder: separate sessions, comparable coordinates.
    const sameCoordinates = await Promise.all([
      profile(reset("armv7e-m")),
      profile(reset("armv7-m", { vectorTableAddress: "0x08000100" })),
    ]);
    for (const other of [movedBase, v8m, ...sameCoordinates])
      expect(other.digest).not.toBe(base.digest);
    for (const other of sameCoordinates)
      expect(coordinates(other)).toEqual(coordinates(base));
    expect(coordinates(movedBase)).not.toEqual(coordinates(base));
    expect(coordinates(v8m)).not.toEqual(coordinates(base));
  });
});
