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
import { ghidraProducerIdentity } from "./GhidraProducerIdentity.js";
import { createAnalysisProfile } from "../domain/analysisProfile.js";
import { packagedSourcesDigest } from "../filesystem/ProducerIdentity.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { GHIDRA_BRIDGE_SOURCES } from "./GhidraBridgeSources.js";

// A profile digest is the digest of its committed parameters; these tests pin
// the parameters (runtime selections and the producer identity) rather than a
// literal hash that every bridge or REA release would have to re-record.
const expectCommittedProfile = (
  profile: ReturnType<typeof createAnalysisProfile> | null | undefined,
): void => {
  if (profile == null) throw new Error("Expected an analysis profile");
  expect(profile.parameters).toMatchObject({
    producer: ghidraProducerIdentity(),
  });
  expect(profile.digest).toBe(
    createAnalysisProfile(profile.provider, profile.parameters).digest,
  );
};

// Raw loads whose base is their caller-selected entry: they commit the
// parameters they committed before separate bases and variants existed.
const LEGACY_RAW_LOADS = [
  ["x86", "0x1000"],
  ["x86_64", "0x401000"],
  ["arm", "0x8000000"],
  ["arm64", "0x80000"],
  ["m68k", "0x1000"],
] as const;

/** Keys only a load with a separate base or a variant commits. */
const RAW_LOAD_KEYS = ["raw_load", "entry_context", "processor_labels"];

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

const rawProfile = async (target: BinaryTarget, disabled?: string) => {
  const config = parseConfig({
    GHIDRA_INSTALL_DIR: "/ghidra",
    ...(disabled === undefined
      ? {}
      : { REA_GHIDRA_DISABLED_ANALYZERS: disabled }),
  });
  if (!config.ok) throw config.error;
  const provider = new GhidraProvider(config.value, silentLogger, {}, host);
  const resolved = await provider.resolveAnalysisProfile(target);
  if (!resolved.ok) throw resolved.error;
  if (resolved.value.profile === null)
    throw new Error("Missing raw analysis profile");
  return resolved.value.profile;
};

it("commits the raw entry and analyzer settings independently of the carrier", async () => {
  const target = raw("6502", "0x8001");
  const analyzer = "Aggressive Instruction Finder";
  const producer = {
    rea_version: PRODUCT_IDENTITY.packageVersion,
    sources_sha256: packagedSourcesDigest(
      new URL("../../bridge/ghidra/", import.meta.url),
      Object.values(GHIDRA_BRIDGE_SOURCES),
    ),
  };
  const standard = await rawProfile(target);
  const shifted = await rawProfile(raw("6502", "0x8002"));
  const custom = await rawProfile(target, analyzer);
  expect(standard.parameters).toMatchObject({
    target_format: "raw-binary",
    loader: "BinaryLoader",
    language_id: "6502:LE:16:default",
    language_selection: "caller-supplied",
    entry_point: "0x8001",
    analyzer_preset: "ghidra-default",
    producer,
  });
  expect(shifted.parameters).toMatchObject({
    entry_point: "0x8002",
    analyzer_preset: "ghidra-default",
  });
  expect(custom.parameters).toMatchObject({
    entry_point: "0x8001",
    analyzer_preset: "ghidra-default+disabled:Aggressive Instruction Finder",
    analysis_options: { disabled_analyzers: [analyzer] },
    producer,
  });
  expect(shifted.digest).not.toBe(standard.digest);
  expect(custom.digest).not.toBe(standard.digest);
});

describe("raw-binary analysis profile commitments", () => {
  it.each(LEGACY_RAW_LOADS)(
    "commits the %s raw profile at entry %s without the M-profile keys",
    async (architecture, entryPoint) => {
      const ghidra = new GhidraProvider(configFor({}), silentLogger, {}, host);
      const resolved = await ghidra.resolveAnalysisProfile(
        raw(architecture, entryPoint),
      );
      if (!resolved.ok) throw resolved.error;
      expectCommittedProfile(resolved.value.profile);
      expect(resolved.value.profile?.parameters).toMatchObject({
        entry_point: entryPoint,
        language_selection: "caller-supplied",
      });
      for (const key of RAW_LOAD_KEYS)
        expect(resolved.value.profile?.parameters).not.toHaveProperty(key);
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

  it("keeps a load admitted without a variant on the legacy parameters", async () => {
    const legacy = await profile(
      admittedRawLoad({
        architecture: "arm",
        entryPoint: "0x08000000",
        fileBytes: 4,
      }),
    );
    expectCommittedProfile(legacy);
    for (const key of RAW_LOAD_KEYS)
      expect(legacy.parameters).not.toHaveProperty(key);
  });

  it.each(ARCHITECTURE_VARIANT_NAMES)(
    "commits the %s decoder, Thumb entry context and raw_load",
    async (variant) => {
      const committed = await profile(reset(variant));
      expect(committed.parameters).toMatchObject({
        language_id: GHIDRA_VARIANT_LANGUAGES[variant],
        compiler_spec_id: "default",
        entry_context: "thumb-tmode-1-before-analysis",
        processor_labels: "not-applied",
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
    const committed = await profile(reset("armv7-m"));
    expectCommittedProfile(committed);
    const { digest } = committed;
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
