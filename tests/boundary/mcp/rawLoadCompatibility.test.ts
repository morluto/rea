import { McpServer } from "@modelcontextprotocol/server";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseConfig } from "../../../src/config/parseConfig.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  snapshotMatchesTarget,
  snapshotTarget,
} from "../../../src/domain/analysisSnapshot.js";
import type { BinaryTarget } from "../../../src/domain/binaryTargetTypes.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import {
  jsonValueSchema,
  type JsonValue,
} from "../../../src/domain/jsonValue.js";
import {
  nativeLoadImageSchema,
  nativeRawLoadImageSchema,
} from "../../../src/domain/native/nativeLoadImage.js";
import { admittedRawLoad } from "../../../src/domain/rawBinary.fixture.js";
import { ghidraProfileInstallationHost as host } from "../../../src/ghidra/GhidraInstallation.fixture.js";
import { attestGhidraRawBinaryLoadImage } from "../../../src/ghidra/GhidraLoadImageValues.js";
import { GhidraProvider } from "../../../src/ghidra/GhidraProvider.js";
import { fixtureRawBinaryLoadImage } from "../../../src/ghidra/GhidraRawBinaryLoadImage.fixture.js";
import { silentLogger } from "../../../src/logger.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";
import { cortexM0Fixture } from "../../conformance/ghidra/cortexM.fixture.mjs";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

const ghidraProfile = async (target: BinaryTarget) => {
  const config = parseConfig({ GHIDRA_INSTALL_DIR: "/ghidra" });
  if (!config.ok) throw config.error;
  const resolved = await new GhidraProvider(
    config.value,
    silentLogger,
    {},
    host,
  ).resolveAnalysisProfile(target);
  if (!resolved.ok) throw resolved.error;
  if (resolved.value.profile === null) throw new Error("expected a profile");
  return resolved.value.profile;
};

// One image holds the vector table and the Thumb code its Reset word names;
// the load is admitted from these bytes.
const segmentsImage = () => {
  const bytes = cortexM0Fixture(0x08000000);
  const rawLoad = admittedRawLoad(
    {
      architecture: "arm",
      architectureVariant: "armv7-m",
      entryPoint: undefined,
      baseAddress: "0x8000000",
      fileBytes: bytes.length,
    },
    bytes.subarray(0, 8),
  );
  const f = fixtureRawBinaryLoadImage(bytes, rawLoad);
  f.observation.entry_context = [
    {
      address: rawLoad.entryPoint,
      registers: [{ name: "TMode", value_hex: "0x1" }],
    },
  ];
  const image = attestGhidraRawBinaryLoadImage(
    f.snapshot,
    f.target,
    f.observation,
  );
  if (!image.ok) throw new Error(image.error);
  if (image.value.status !== "verified")
    throw new Error("the segments image fixture does not verify");
  return { target: f.target, image: image.value };
};

describe("raw-binary loads without the M-profile inputs", () => {
  it("keep the target selection and profile they had before those inputs", async () => {
    const f = fixtureRawBinaryLoadImage();
    const target = {
      ...f.target,
      rawLoad: admittedRawLoad({
        architecture: "arm",
        entryPoint: "0x08000000",
        fileBytes: 4,
      }),
    };
    // A legacy load selects its entry only, as before these inputs.
    expect(snapshotTarget(target).identity.selection).toStrictEqual({
      kind: "entry-point",
      entry_point: "0x8000000",
    });
    const parameters = (await ghidraProfile(target)).parameters;
    expect(parameters).toMatchObject({ entry_point: "0x8000000" });
    for (const key of ["raw_load", "entry_context", "processor_labels"])
      expect(parameters).not.toHaveProperty(key);
  });

  it("are not the target or profile of an M-profile load of the same file", async () => {
    const f = fixtureRawBinaryLoadImage();
    const legacy = {
      ...f.target,
      rawLoad: admittedRawLoad({
        architecture: "arm",
        entryPoint: "0x08000000",
        fileBytes: 4,
      }),
    };
    const variant = {
      ...f.target,
      rawLoad: admittedRawLoad({
        architecture: "arm",
        architectureVariant: "armv7-m",
        baseAddress: "0x8000000",
        entryPoint: "0x8000000",
        fileBytes: 4,
      }),
    };
    expect(snapshotMatchesTarget(snapshotTarget(legacy), variant)).toBe(false);
    expect((await ghidraProfile(variant)).digest).not.toBe(
      (await ghidraProfile(legacy)).digest,
    );
  });
});

describe("raw-binary load-image Evidence shapes", () => {
  it("keeps the earlier raw-binary shape closed to segments images", () => {
    // Readers that predate segments parse load images with this schema; they
    // refuse the new shape instead of misreading it as a raw-binary image.
    const { image } = segmentsImage();
    expect(nativeLoadImageSchema.safeParse(image).success).toBe(true);
    expect(nativeRawLoadImageSchema.safeParse(image).success).toBe(false);
    expect(
      nativeLoadImageSchema.safeParse({ ...image, version: 2 }).success,
    ).toBe(false);
  });

  mcpTest(
    "advertises output that accepts raw-binary and segments images",
    async ({ mcp }) => {
      const contract = toolContract("inspect_native_load_image");
      const server = new McpServer({ name: "raw-load-images", version: "1" });
      server.registerTool(
        contract.name,
        toolRegistrationOptions(contract),
        async () => ({ content: [] }),
      );
      const client = await mcp.connect(server);
      const advertised = (await client.listTools()).tools.find(
        ({ name }) => name === contract.name,
      );
      if (advertised?.outputSchema === undefined)
        throw new Error("Load-image output schema missing");
      const ajv = new Ajv2020({ strict: false, validateFormats: false });
      const validate = ajv.compile(
        z.record(z.string(), z.unknown()).parse(advertised.outputSchema),
      );
      const evidence = (result: JsonValue) =>
        createEvidence(
          fixtureRawBinaryLoadImage().target,
          { id: "ghidra", name: "Ghidra", version: "12.2" },
          { operation: contract.name, parameters: {}, result },
        );
      const f = fixtureRawBinaryLoadImage();
      const legacyImage = attestGhidraRawBinaryLoadImage(
        f.snapshot,
        f.target,
        f.observation,
      );
      if (!legacyImage.ok) throw new Error(legacyImage.error);
      const saved = jsonValueSchema.parse(legacyImage.value);
      const image = jsonValueSchema.parse(segmentsImage().image);
      expect(validate(evidence(saved))).toBe(true);
      expect(validate(evidence(image))).toBe(true);
      expect(
        validate(
          evidence(
            jsonValueSchema.parse({ ...segmentsImage().image, version: 2 }),
          ),
        ),
      ).toBe(false);
    },
  );
});

describe("open_binary inputs from before base_address", () => {
  mcpTest(
    "stay valid in the advertised input schema beside the new inputs",
    async ({ mcp }) => {
      const contract = toolContract("open_binary");
      const server = new McpServer({ name: "raw-load-inputs", version: "1" });
      server.registerTool(
        contract.name,
        toolRegistrationOptions(contract),
        async () => ({ content: [] }),
      );
      const client = await mcp.connect(server);
      const advertised = (await client.listTools()).tools.find(
        ({ name }) => name === contract.name,
      );
      if (advertised === undefined) throw new Error("open_binary missing");
      const ajv = new Ajv2020({ strict: false, validateFormats: false });
      const validate = ajv.compile(
        z.record(z.string(), z.unknown()).parse(advertised.inputSchema),
      );
      const legacy = {
        path: "/tmp/ecu.bin",
        format: "raw-binary",
        architecture: "arm",
        entry_point: "0x8000000",
      };
      expect(validate(legacy)).toBe(true);
      expect(
        validate({
          path: "/tmp/flash.bin",
          format: "raw-binary",
          architecture: "arm",
          architecture_variant: "armv8-m.main",
          base_address: "0x08000000",
          vector_table_address: "0x08000200",
        }),
      ).toBe(true);
      expect(validate({ ...legacy, architecture_variant: "cortex-m" })).toBe(
        false,
      );
    },
  );
});
