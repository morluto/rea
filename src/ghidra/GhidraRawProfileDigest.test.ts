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
// status, load-image relocation-symbol and procedure search revisions that
// prevent reuse of snapshots with earlier results.
const RAW_DIGESTS = {
  "6502": "7850ec8d885a9b5e1e6791637b57dfcea2d4359d55754ceeaf858fc43b22293d",
  "x86-disabled-analyzer":
    "55fb2b19e10d32bea95a88a097029ab2ad705b4b81dc74844662191799dbb161",
} as const;

// Computed by upstream main at d3ab0faf5, which has neither a separate base nor
// a variant. A raw load whose base is its caller-selected entry keeps these
// profile digests, so it stays reusable wherever main's raw sessions and
// snapshots are.
const LEGACY_RAW_DIGESTS = [
  [
    "x86",
    "0x1000",
    "17c7f8a82ec7dc9a9d1fec3452714d27220805700a586c45a450dd7dcf2843bd",
  ],
  [
    "x86_64",
    "0x401000",
    "334c8103c052bd271070c41f368ff7084503ec9d5d2eafab43da719674f4368b",
  ],
  [
    "arm",
    "0x8000000",
    "e2706d325c06e3dc9a5efe287343b8c5b0cc48fcaab55627861e0adf44aab3d0",
  ],
  [
    "arm64",
    "0x80000",
    "cfb746b337bda0741c60efc49c4faf1a1e8f9cf20af77c4733d60607ad31e4a1",
  ],
  [
    "m68k",
    "0x1000",
    "e785dbd3ef3e0b49b8897d3011341204b28ec0cf2d65a07b8e6fcd6b25bde9b3",
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
      "8a146adc83ab3643aa90d87e9c6bd54ea0747c81e295f521aef3ea27ea353b4e",
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
