import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { UefiAnalysisService } from "../application/uefi/UefiAnalysisService.js";
import { AMD_ZLIB_HEADER_LENGTH } from "./FfsSections.js";
import {
  buildFfsFile,
  buildFv,
  buildGuidedSection,
  buildImage,
  buildLzmaGuidedSection,
  buildSection,
} from "../../tests/fixtures/uefiImage.js";
import { UefiAnalysisProvider } from "./UefiAnalysisProvider.js";
import {
  uefiRequestSchema,
  type UefiExtractResult,
  type UefiInspectResult,
} from "../domain/uefi/uefiFirmwareAnalysis.js";

/** Compiled worker lane; the unit tests without dist skip real decodes. */
const distUefiLzmaWorker = fileURLToPath(
  new URL("../../dist/uefi/UefiLzmaWorker.js", import.meta.url),
);
const lzmaPurescript = createRequire(import.meta.url)(
  "lzma-purejs",
) as unknown as {
  compressFile: (buffer: Buffer) => Uint8Array;
};

const GUID_DRIVER = "3c1b0309-0000-4444-8888-444488883333";
const GUID_RAW = "1111aaaa-2222-4333-8444-555555555555";
const GUID_PAD = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const GUID_GUIDED = "22224444-8888-4444-8888-444488884444";
const GUID_AMD_ZLIB = "ce3233f5-2cd6-4d87-9152-4a238bb6d1c4";

const MODULE_A = Buffer.from("MODULE-APAYLOAD-B550-AORUS-ELITE-V2", "utf8");
const RAW_BODY = Buffer.from("RAWFILEBODY-BYTES", "utf8");
const GUIDED_BODY = Buffer.from("GUIDEDPAYLOAD-EE4E5898", "utf8");

const buildTestImage = ({ withGuided = true } = {}): Buffer => {
  const driver = buildFfsFile({
    guid: GUID_DRIVER,
    typeCode: 0x07,
    payload: Buffer.concat([
      buildSection(0x10, MODULE_A),
      ...(withGuided
        ? [
            buildGuidedSection({
              definitionGuid: GUID_GUIDED,
              body: GUIDED_BODY,
            }),
          ]
        : []),
    ]),
  });
  const raw = buildFfsFile({
    guid: GUID_RAW,
    typeCode: 0x01,
    payload: RAW_BODY,
  });
  const pad = buildFfsFile({
    guid: GUID_PAD,
    typeCode: 0xf0,
    payload: Buffer.alloc(0),
  });
  const volume = buildFv({ files: [pad, driver, raw] });
  return buildImage({ volumes: [volume.buffer] });
};

const writeTestImage = async (options?: {
  readonly withGuided?: boolean;
}): Promise<{
  readonly imagePath: string;
  readonly directory: string;
}> => {
  const directory = await createTestTempDirectory("rea-uefi-provider-");
  const imagePath = join(directory, "image.fi");
  await writeFile(imagePath, buildTestImage(options));
  return { imagePath, directory };
};

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Schema-validated admission, identical to the shared provider execution. */
const inspectRequest = (path: string) =>
  uefiRequestSchema.parse({
    operation: "inspect_uefi_firmware",
    input: { path },
  });

const extractRequest = (
  path: string,
  outputDirectory: string,
  overrides?: {
    readonly target?:
      | { readonly kind: "whole-image" }
      | { readonly kind: "volume"; readonly offset: number };
    readonly max_output_files?: number;
    readonly include_compressed?: boolean;
  },
) =>
  uefiRequestSchema.parse({
    operation: "extract_uefi_firmware",
    input: { path, output_directory: outputDirectory, ...overrides },
  });

const expectOk = <
  T extends
    | { readonly ok: true; readonly value: { readonly result: unknown } }
    | { readonly ok: false; readonly error: unknown },
>(
  executed: T,
): Extract<T, { readonly ok: true }> => {
  if (!executed.ok) {
    throw new Error(JSON.stringify(executed.error, null, 2));
  }
  return executed as Extract<T, { readonly ok: true }>;
};

it("maps a flash image into an inspect execution with volume and section coverage", async () => {
  const { imagePath } = await writeTestImage();
  const provider = new UefiAnalysisProvider();
  const executed = expectOk(
    await provider.execute(await inspectRequest(imagePath)),
  );
  const result = executed.value.result as UefiInspectResult;
  const image = await readFile(imagePath);
  expect(result.parser.name).toBe("rea-uefi");
  expect(result.flash_image.sha256).toBe(sha256(image));
  expect(result.flash_image.entry_basis).toBe("fv-at-zero");
  expect(result.firmware_volumes).toHaveLength(1);
  const volume0 = result.firmware_volumes[0];
  expect(volume0?.ffs_files.map((file) => file.type_name)).toContain("driver");
  expect(result.coverage).toBe("complete");
  expect(executed.value.subject?.sha256).toBe(sha256(image));
  await provider.close();
});

it("extracts whole-image payloads with section provenance and published bytes", async () => {
  // Without a guided section, everything requested is publishable: pad files
  // stay in place by design, so they never downgrade coverage.
  const { imagePath, directory } = await writeTestImage({ withGuided: false });
  const provider = new UefiAnalysisProvider();
  const executed = expectOk(
    await provider.execute(
      await extractRequest(imagePath, join(directory, "out")),
    ),
  );
  const result = executed.value.result as UefiExtractResult;
  expect(result.selection.target_kind).toBe("whole-image");
  expect(result.coverage).toBe("complete");
  expect(result.derivations).toHaveLength(0);
  const rawSection = result.files.find((file) => file.source === "raw-section");
  expect(rawSection?.size).toBe(MODULE_A.length);
  const rawBytes = await readFile(rawSection?.path ?? "");
  expect(rawBytes.equals(MODULE_A)).toBe(true);
  const padGap = result.extraction_gaps.find((gap) => gap.kind === "pad-file");
  expect(padGap).toBeDefined();
  expect(result.published_bytes).toBe(
    result.files.reduce((total, file) => total + file.size, 0),
  );
});

it("publishes the unknown-guid carrier and reports the decoding gap explicitly", async () => {
  const { imagePath, directory } = await writeTestImage();
  const provider = new UefiAnalysisProvider();
  const executed = expectOk(
    await provider.execute(
      await extractRequest(imagePath, join(directory, "out")),
    ),
  );
  const result = executed.value.result as UefiExtractResult;
  const guidedGap = result.extraction_gaps.find(
    (gap) => gap.kind === "unknown-guid-handler",
  );
  expect(guidedGap).toBeDefined();
  const carrier = result.files.find(
    (file) => file.source === "compressed-passthrough",
  );
  expect(carrier?.size).toBe(GUIDED_BODY.length);
  expect((await readFile(carrier?.path ?? "")).equals(GUIDED_BODY)).toBe(true);
});

it("withholds carriers when include_compressed is disabled", async () => {
  const { imagePath, directory } = await writeTestImage();
  const provider = new UefiAnalysisProvider();
  const executed = expectOk(
    await provider.execute(
      await extractRequest(imagePath, join(directory, "out"), {
        include_compressed: false,
      }),
    ),
  );
  const result = executed.value.result as UefiExtractResult;
  expect(
    result.files.find((file) => file.source === "compressed-passthrough"),
  ).toBeUndefined();
  expect(result.coverage).toBe("partial");
});

it("stops staging at the file budget and downgrades coverage", async () => {
  const { imagePath, directory } = await writeTestImage();
  const provider = new UefiAnalysisProvider();
  const executed = expectOk(
    await provider.execute(
      await extractRequest(imagePath, join(directory, "out-tight"), {
        max_output_files: 1,
      }),
    ),
  );
  const result = executed.value.result as UefiExtractResult;
  expect(result.files).toHaveLength(1);
  expect(result.coverage).toBe("partial");
  expect(
    result.extraction_gaps.some((gap) => gap.kind === "size-truncated"),
  ).toBe(true);
});

it("rejects extraction scopes that do not match a scanned record", async () => {
  const { imagePath, directory } = await writeTestImage();
  const provider = new UefiAnalysisProvider();
  const executed = await provider.execute(
    await extractRequest(imagePath, join(directory, "out"), {
      target: { kind: "volume", offset: 0xdeadbeef },
    }),
  );
  expect(executed.ok).toBe(false);
  if (executed.ok) return;
  expect(executed.error._tag).toBe("AnalysisInputError");
});

const lzmaWorkerAvailable = existsSync(distUefiLzmaWorker);

it.skipIf(!lzmaWorkerAvailable)(
  "decodes an LZMA-custom section through the owned worker and derives it",
  async () => {
    const decoded = Buffer.from("FVMAIN-DECODED-PAYLOAD-".repeat(64), "utf8");
    const directory = await createTestTempDirectory("rea-uefi-provider-");
    const compressed = lzmaPurescript.compressFile(decoded);
    const driver = buildFfsFile({
      guid: GUID_DRIVER,
      typeCode: 0x07,
      payload: buildLzmaGuidedSection(Buffer.from(compressed)),
    });
    const volume = buildFv({ files: [driver] });
    const imagePath = join(directory, "lzma-image.fi");
    await writeFile(imagePath, buildImage({ volumes: [volume.buffer] }));
    const provider = new UefiAnalysisProvider(distUefiLzmaWorker);
    const executed = expectOk(
      await provider.execute(
        await extractRequest(imagePath, join(directory, "out-lzma")),
      ),
    );
    const result = executed.value.result as UefiExtractResult;
    const decodedFile = result.files.find(
      (file) => file.source === "decompressed-lzma",
    );
    expect(decodedFile?.size).toBe(decoded.length);
    expect((await readFile(decodedFile?.path ?? "")).equals(decoded)).toBe(
      true,
    );
    expect(result.derivations).toHaveLength(1);
    expect(result.derivations[0]?.handler.startsWith("lzma-purejs@0.9.")).toBe(
      true,
    );
    // The only gap is the pad file; the LZMA stream decoded, so coverage holds.
    expect(result.extraction_gaps.every((gap) => gap.kind === "pad-file")).toBe(
      true,
    );
    expect(result.coverage).toBe("complete");
  },
  45_000,
);

it("decodes an AMI-zlib section on the main thread and derives it as decompressed-zlib", async () => {
  const nestedInner = buildFfsFile({
    guid: GUID_RAW,
    typeCode: 0x07,
    payload: buildSection(0x10, Buffer.from("ZLIB-NESTED-PAYLOAD", "utf8")),
  });
  const decoded = buildFv({ files: [nestedInner] }).buffer;
  const directory = await createTestTempDirectory("rea-uefi-provider-");
  const stream = deflateSync(decoded);
  const amdHeader = Buffer.alloc(AMD_ZLIB_HEADER_LENGTH, 0);
  amdHeader.writeUInt32LE(stream.length, 0x14);
  const driver = buildFfsFile({
    guid: GUID_DRIVER,
    typeCode: 0x07,
    payload: buildGuidedSection({
      definitionGuid: GUID_AMD_ZLIB,
      body: Buffer.concat([amdHeader, stream]),
    }),
  });
  const volume = buildFv({ files: [driver] });
  const imagePath = join(directory, "zlib-image.fi");
  await writeFile(imagePath, buildImage({ volumes: [volume.buffer] }));
  const provider = new UefiAnalysisProvider();

  const inspected = expectOk(
    await provider.execute(await inspectRequest(imagePath)),
  );
  const inspectResult = inspected.value.result as UefiInspectResult;
  expect(inspectResult.firmware_volumes).toHaveLength(2);
  expect(inspectResult.firmware_volumes[1]?.logical_path).toContain(
    "/zlib/FV@",
  );

  const executed = expectOk(
    await provider.execute(
      await extractRequest(imagePath, join(directory, "out-zlib")),
    ),
  );
  const result = executed.value.result as UefiExtractResult;
  const decodedFile = result.files.find(
    (file) => file.source === "decompressed-zlib",
  );
  expect(decodedFile?.size).toBe(decoded.length);
  expect((await readFile(decodedFile?.path ?? "")).equals(decoded)).toBe(true);
  // The nested volume's own file is carved out of the decoded stream, not
  // just available as the monolithic stream blob.
  const nestedSection = result.files.find(
    (file) =>
      file.relative_path.includes("/zlib/FV@") &&
      file.relative_path.endsWith(".payload.bin"),
  );
  expect(nestedSection?.source).toBe("raw-section");
  expect(nestedSection?.parent_logical_path).toContain("/zlib/FV@");
  expect(
    (await readFile(nestedSection?.path ?? "")).equals(
      Buffer.from("ZLIB-NESTED-PAYLOAD"),
    ),
  ).toBe(true);
  expect(result.derivations).toHaveLength(1);
  expect(result.derivations[0]?.handler.startsWith("node-zlib@")).toBe(true);
  expect(result.coverage).toBe("complete");
  expect(result.extraction_gaps).toHaveLength(0);
});

it("extracts embedded raw-file volume files and targets the nested volume by offset", async () => {
  const holeInner = buildFfsFile({
    guid: "25111111-2222-3333-4444-555555555555",
    typeCode: 0x07,
    payload: buildSection(0x10, Buffer.from("HOLE-NESTED-PAYLOAD", "utf8")),
  });
  const holeFv = buildFv({ files: [holeInner] });
  // Raw file body = full FV (zero vector first): the AMI ROM-hole pattern.
  const hole = buildFfsFile({
    guid: "27111111-2222-3333-4444-555555555555",
    typeCode: 0x01,
    payload: holeFv.buffer,
  });
  const volume = buildFv({ files: [hole] });
  const directory = await createTestTempDirectory("rea-uefi-provider-");
  const imagePath = join(directory, "hole-image.fi");
  await writeFile(imagePath, buildImage({ volumes: [volume.buffer] }));
  const provider = new UefiAnalysisProvider();

  const inspected = expectOk(
    await provider.execute(await inspectRequest(imagePath)),
  );
  const inspectResult = inspected.value.result as UefiInspectResult;
  const nested = inspectResult.firmware_volumes.find((candidate) =>
    candidate.logical_path.includes("/embedded/FV@"),
  );
  expect(nested).toBeDefined();
  expect(nested?.ffs_files).toHaveLength(1);

  const whole = expectOk(
    await provider.execute(
      await extractRequest(imagePath, join(directory, "out-all")),
    ),
  );
  const wholeResult = whole.value.result as UefiExtractResult;
  const wholePayload = wholeResult.files.find(
    (file) =>
      file.relative_path.includes("/embedded/FV@") &&
      file.relative_path.endsWith(".payload.bin"),
  );
  expect(wholePayload?.source).toBe("raw-section");
  expect(wholePayload?.parent_logical_path?.includes("/embedded/FV@")).toBe(
    true,
  );
  expect(
    (await readFile(wholePayload?.path ?? "")).equals(
      Buffer.from("HOLE-NESTED-PAYLOAD"),
    ),
  ).toBe(true);
  expect(wholeResult.coverage).toBe("complete");

  const scoped = expectOk(
    await provider.execute(
      await extractRequest(imagePath, join(directory, "out-nested"), {
        target: { kind: "volume", offset: nested?.offset ?? -1 },
      }),
    ),
  );
  const scopedResult = scoped.value.result as UefiExtractResult;
  expect(scopedResult.files).toHaveLength(1);
  expect(
    (await readFile(scopedResult.files[0]?.path ?? "")).equals(
      Buffer.from("HOLE-NESTED-PAYLOAD"),
    ),
  ).toBe(true);
  await provider.close();
});

it("validates requests through the service before execution", async () => {
  const provider = new UefiAnalysisProvider();
  const service = new UefiAnalysisService(provider);
  const rejected = await service.execute("inspect_uefi_firmware", {
    path: "relative/image.fi",
  });
  expect(rejected.ok).toBe(false);
  if (rejected.ok) return;
  expect(rejected.error._tag).toBe("AnalysisInputError");
});
