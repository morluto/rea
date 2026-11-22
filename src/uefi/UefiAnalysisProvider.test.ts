import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import { SafeOutputTree } from "../resources/SafeOutputTree.js";
import { SafeOutputTreeCreationFailure } from "../resources/SafeOutputTreeCreationFailure.js";
import { ProviderProcessSupervisor } from "../process/ProviderProcess.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";
import { createDeferred } from "../../tests/fixtures/binarySession.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { UefiAnalysisService } from "../application/uefi/UefiAnalysisService.js";
import { AMD_ZLIB_HEADER_LENGTH } from "./FfsSections.js";
import {
  buildCompressionSection,
  buildFfsFile,
  buildFv,
  buildGuidedSection,
  buildImage,
  buildLzmaGuidedSection,
  buildSection,
  guidBytes,
} from "../../tests/fixtures/uefiImage.js";
import { FFS2_FILE_SYSTEM_GUID, FFS3_FILE_SYSTEM_GUID } from "./UefiGuid.js";
import { UefiAnalysisProvider } from "./UefiAnalysisProvider.js";
import {
  uefiRequestSchema,
  type UefiExtractResult,
  type UefiRequest,
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
    readonly target?: Extract<
      UefiRequest,
      { operation: "extract_uefi_firmware" }
    >["input"]["target"];
    readonly max_depth?: number;
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
  expect(result.coverage).toBe("partial");
  expect(result.limitations.join(" ")).toContain("unknown-guid");
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
  const rawBody = result.files.find(
    (file) => file.source === "uncompressed-payload",
  );
  expect((await readFile(rawBody?.path ?? "")).equals(RAW_BODY)).toBe(true);
  expect(rawBody?.relative_path).not.toContain(":");
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
    expect(result.extraction_gaps).toMatchObject([
      {
        kind: "unparsed-region",
        source_stream: result.derivations[0]?.child_stream,
        range: { offset: 0, length: decoded.length },
      },
    ]);
    expect(result.coverage).toBe("partial");
  },
  45_000,
);

it.skipIf(!lzmaWorkerAvailable)(
  "restores an EDK II LZMAF86 section stream before mapping and extracting its PE payload",
  async () => {
    const pePayload = Buffer.from(
      "4d5a90e80c00000090e9f1ffffff9090e8e9ff00009090c3e9",
      "hex",
    );
    // EDK II LzmaCompress -e --f86 at 556dcfb466e9f05affeaff881d738807f8156d3c,
    // over buildSection(0x10, pePayload). Plain LZMA leaves different operands.
    const compressed = Buffer.from(
      "5d000000012000000000000000000e802f20d6bb0779fccd0af806e72f54b89b62db3e8de253e82174580000",
      "hex",
    );
    const file = buildFfsFile({
      guid: GUID_DRIVER,
      typeCode: 0x07,
      payload: buildGuidedSection({
        definitionGuid: "d42ae6bd-1352-4bfb-909a-ca72a6eae889",
        body: compressed,
      }),
    });
    const directory = await createTestTempDirectory("rea-uefi-f86-");
    const imagePath = join(directory, "image.fi");
    await writeFile(imagePath, buildFv({ files: [file] }).buffer);
    const provider = new UefiAnalysisProvider(distUefiLzmaWorker);

    const result = expectOk(
      await provider.execute(
        extractRequest(imagePath, join(directory, "out"), {
          include_compressed: false,
        }),
      ),
    ).value.result as UefiExtractResult;
    expect(result.coverage).toBe("complete");
    expect(result.extraction_gaps).toEqual([]);
    expect(result.derivations).toMatchObject([
      {
        handler: expect.stringContaining("+x86-bcj"),
        parent_file_range: { length: compressed.length },
      },
    ]);
    const restored = result.files.find(
      (entry) => entry.source === "decompressed-lzmaf86",
    );
    const payload = result.files.find(
      (entry) => entry.source === "raw-section",
    );
    if (restored === undefined || payload === undefined) {
      throw new Error(
        "LZMAF86 extraction did not publish its stream and PE payload",
      );
    }
    expect(
      (await readFile(restored.path)).equals(buildSection(0x10, pePayload)),
    ).toBe(true);
    expect((await readFile(payload.path)).equals(pePayload)).toBe(true);
    expect(payload).toMatchObject({
      source_stream: restored.source_stream,
      source_range: { offset: 4, length: pePayload.length },
      original_file_range: null,
    });
  },
  45_000,
);

const amdZlibSection = (content: Buffer, suffix = Buffer.alloc(0)): Buffer => {
  const stream = Buffer.concat([deflateSync(content), suffix]);
  const amdHeader = Buffer.alloc(AMD_ZLIB_HEADER_LENGTH);
  amdHeader.writeUInt32LE(stream.length, 0x14);
  return buildGuidedSection({
    definitionGuid: GUID_AMD_ZLIB,
    body: Buffer.concat([amdHeader, stream]),
  });
};

it("decodes nested zlib streams and preserves each carrier and PE byte range in scoped extraction", async () => {
  const pe = Buffer.from("ZLIB-NESTED-PAYLOAD");
  const ui = buildSection(0x15, Buffer.from("Setup\0", "utf16le"));
  const innerChain = Buffer.concat([ui, buildSection(0x10, pe)]);
  const nestedInner = buildFfsFile({
    guid: GUID_RAW,
    typeCode: 0x07,
    payload: amdZlibSection(innerChain),
  });
  const decoded = buildFv({ files: [nestedInner] }).buffer;
  const directory = await createTestTempDirectory("rea-uefi-provider-");
  const driver = buildFfsFile({
    guid: GUID_DRIVER,
    typeCode: 0x07,
    payload: amdZlibSection(decoded),
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

  const nested = inspectResult.firmware_volumes[1];
  const module = nested?.ffs_files[0];
  const peSection = module?.sections.find(
    (section) => section.type_name === "pe32",
  );
  expect(module?.ui_string).toBe("Setup");
  expect(peSection?.offset).toBe(ui.length);
  if (peSection?.source_stream == null)
    throw new Error("PE lost its decoded source");

  const ambiguous = await provider.execute(
    extractRequest(imagePath, join(directory, "ambiguous"), {
      target: { kind: "volume", offset: 0 },
    }),
  );
  expect(ambiguous.ok).toBe(false);
  if (!ambiguous.ok) expect(ambiguous.error._tag).toBe("AnalysisInputError");

  const extracted = expectOk(
    await provider.execute(
      extractRequest(imagePath, join(directory, "scoped"), {
        target: {
          kind: "section",
          offset: peSection.offset,
          source_stream: peSection.source_stream,
        },
      }),
    ),
  ).value.result as UefiExtractResult;
  expect(extracted.files).toHaveLength(1);
  const leaf = extracted.files[0];
  expect((await readFile(leaf?.path ?? "")).equals(pe)).toBe(true);
  expect(leaf).toMatchObject({
    original_file_range: null,
    source_stream: peSection.source_stream,
    source_range: { offset: ui.length + 4, length: pe.length },
  });
  expect(extracted.derivations).toHaveLength(2);
  const [outer, inner] = extracted.derivations;
  expect(outer?.parent_file_range?.offset).toBe(
    72 + 24 + 24 + AMD_ZLIB_HEADER_LENGTH,
  );
  expect(inner).toMatchObject({
    parent_file_range: null,
    parent_stream: outer?.child_stream,
    parent_stream_range: { offset: 72 + 24 + 24 + AMD_ZLIB_HEADER_LENGTH },
    child_stream: peSection.source_stream,
    child_path: null,
  });
  expect(extracted.coverage).toBe("complete");

  const wrapper = inspectResult.firmware_volumes[0]?.ffs_files[0];
  for (const [kind, offset] of [
    ["volume", 0],
    ["ffs-file", wrapper?.offset ?? -1],
  ] as const) {
    const scoped = expectOk(
      await provider.execute(
        extractRequest(imagePath, join(directory, kind), {
          target: { kind, offset, source_stream: null },
        }),
      ),
    ).value.result as UefiExtractResult;
    const published = scoped.files.find((file) => file.sha256 === sha256(pe));
    expect((await readFile(published?.path ?? "")).equals(pe)).toBe(true);
    expect(scoped.coverage).toBe("complete");
  }
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

it("publishes repeated raw GUIDs under distinct portable paths and exposes unusable sections as gaps", async () => {
  const directory = await createTestTempDirectory("rea-uefi-provider-");
  const imagePath = join(directory, "image.bin");
  const first = buildFfsFile({
    guid: GUID_RAW,
    typeCode: 1,
    payload: RAW_BODY,
  });
  const second = buildFfsFile({
    guid: GUID_RAW,
    typeCode: 1,
    payload: Buffer.from("other raw bytes"),
  });
  const standard = buildCompressionSection(
    Buffer.from([0x01, 0x23, 0x45]),
    1,
    172,
  );
  const truncated = Buffer.from([0xff, 0x0f, 0, 0x10, 0xde, 0xad]);
  const driver = buildFfsFile({
    guid: GUID_DRIVER,
    typeCode: 7,
    payload: Buffer.concat([standard, truncated]),
  });
  await writeFile(
    imagePath,
    buildFv({ files: [first, second, driver] }).buffer,
  );
  const provider = new UefiAnalysisProvider();
  const result = expectOk(
    await provider.execute(
      extractRequest(imagePath, join(directory, "out"), {
        include_compressed: false,
      }),
    ),
  ).value.result as UefiExtractResult;
  expect(result.coverage).toBe("partial");
  expect(result.files).toHaveLength(2);
  expect(
    new Set(result.files.map(({ relative_path }) => relative_path)).size,
  ).toBe(2);
  expect(
    await Promise.all(result.files.map(({ path }) => readFile(path))),
  ).toEqual([RAW_BODY, Buffer.from("other raw bytes")]);
  expect(result.extraction_gaps).toMatchObject([
    {
      kind: "unsupported-compression",
      detail: expect.stringContaining("efi-standard"),
    },
    { kind: "size-truncated", detail: expect.stringContaining("4095") },
  ]);
});

it("publishes valid siblings with truthful coverage for a zero declaration and an empty carrier", async () => {
  const valid = buildSection(0x10, MODULE_A);
  const emptyCarrier = buildCompressionSection(Buffer.alloc(0), 1, 4);
  const zeroSize = Buffer.from([0, 0, 0, 0x10]);
  const driver = buildFfsFile({
    guid: GUID_DRIVER,
    typeCode: 7,
    payload: Buffer.concat([valid, emptyCarrier, zeroSize]),
  });
  const directory = await createTestTempDirectory("rea-uefi-provider-");
  const imagePath = join(directory, "image.fi");
  await writeFile(imagePath, buildFv({ files: [driver] }).buffer);
  const provider = new UefiAnalysisProvider();
  const result = expectOk(
    await provider.execute(extractRequest(imagePath, join(directory, "out"))),
  ).value.result as UefiExtractResult;
  expect(result.coverage).toBe("partial");
  expect(result.files).toHaveLength(1);
  expect((await readFile(result.files[0]?.path ?? "")).equals(MODULE_A)).toBe(
    true,
  );
  expect(result.extraction_gaps).toMatchObject([
    { kind: "unsupported-compression", range: null },
    {
      kind: "unparsed-region",
      range: {
        offset: 72 + 24 + valid.length + emptyCarrier.length,
        length: zeroSize.length,
      },
      detail: expect.stringContaining("declared 0 bytes, observed 4"),
    },
  ]);
});

it("rolls back staged files if the receipts cannot form a valid extraction result", async () => {
  const { imagePath, directory } = await writeTestImage({ withGuided: false });
  const provider = new UefiAnalysisProvider();
  const output = join(directory, "out");
  const write = SafeOutputTree.prototype.write;
  const writing = vi
    .spyOn(SafeOutputTree.prototype, "write")
    .mockImplementationOnce(async function (this: SafeOutputTree, ...args) {
      const receipt = await write.apply(this, args);
      return { ...receipt, sha256: "invalid-receipt-digest" };
    });
  try {
    const result = await provider.execute(extractRequest(imagePath, output));
    expect(result.ok).toBe(false);
    expect(existsSync(output)).toBe(false);
  } finally {
    writing.mockRestore();
    await provider.close();
  }
});

it.skipIf(!lzmaWorkerAvailable)(
  "retains the worker root across a failed child stop retry and stops its child before root removal",
  async () => {
    const driver = buildFfsFile({
      guid: GUID_DRIVER,
      typeCode: 7,
      payload: buildLzmaGuidedSection(
        Buffer.from(lzmaPurescript.compressFile(Buffer.from("worker output"))),
      ),
    });
    const directory = await createTestTempDirectory("rea-uefi-provider-");
    const imagePath = join(directory, "image.fi");
    await writeFile(imagePath, buildFv({ files: [driver] }).buffer);
    const provider = new UefiAnalysisProvider(distUefiLzmaWorker);
    const create = PrivateRuntimeRoot.create;
    const stopProcess = ProviderProcessSupervisor.prototype.stop;
    const closeRoot = PrivateRuntimeRoot.prototype.close;
    let root: PrivateRuntimeRoot | undefined;
    let workerPid: number | undefined;
    let denyStop = true;
    let denyRoot = true;
    const creating = vi
      .spyOn(PrivateRuntimeRoot, "create")
      .mockImplementation(async (options) => {
        const created = await create(options);
        if (options?.prefix === "rea-uefi-lzma-") root = created;
        return created;
      });
    const stopping = vi
      .spyOn(ProviderProcessSupervisor.prototype, "stop")
      .mockImplementation(async function (this: ProviderProcessSupervisor) {
        workerPid = this.launch.process.pid;
        if (denyStop) {
          return { status: "incomplete", reason: "worker stop denied" };
        }
        return stopProcess.call(this);
      });
    const closingRoot = vi
      .spyOn(PrivateRuntimeRoot.prototype, "close")
      .mockImplementation(async function (this: PrivateRuntimeRoot) {
        if (this === root && denyRoot)
          throw new Error("worker root removal denied");
        return closeRoot.call(this);
      });

    try {
      const result = await provider.execute(inspectRequest(imagePath));
      if (result.ok || root === undefined || workerPid === undefined) {
        throw new Error("worker stop failure was not exercised");
      }
      expect(result.error.cleanupResources).toEqual(
        expect.arrayContaining([root.path, `pid:${String(workerPid)}`]),
      );
      expect(result.error.partialObservation).toMatchObject({
        kind: "uefi",
        result: {
          firmware_volumes: [
            expect.objectContaining({
              ffs_files: [expect.objectContaining({ guid: GUID_DRIVER })],
            }),
          ],
        },
        provenance: {
          path: imagePath,
        },
      });
      await expect(provider.close()).rejects.toThrow(
        /cleanup remains incomplete/i,
      );
      expect(closingRoot.mock.contexts).not.toContain(root);
      expect(existsSync(root.path)).toBe(true);

      denyStop = false;
      await expect(provider.close()).rejects.toThrow(
        /cleanup remains incomplete/i,
      );
      expect(result.error.cleanupResources).toEqual([root.path]);
      expect(existsSync(root.path)).toBe(true);

      denyRoot = false;
      await expect(provider.close()).resolves.toBeUndefined();
      expect(existsSync(root.path)).toBe(false);
      expect(result.error.cleanupIncomplete).toBe(false);
    } finally {
      denyStop = false;
      denyRoot = false;
      creating.mockRestore();
      stopping.mockRestore();
      closingRoot.mockRestore();
      await provider.close();
    }
  },
  45_000,
);

it.skipIf(!lzmaWorkerAvailable)(
  "retains the completed inspection when cancellation arrives during pooled worker shutdown",
  async () => {
    const driver = buildFfsFile({
      guid: GUID_DRIVER,
      typeCode: 7,
      payload: buildLzmaGuidedSection(
        Buffer.from(lzmaPurescript.compressFile(Buffer.from("worker output"))),
      ),
    });
    const directory = await createTestTempDirectory(
      "rea-uefi-late-worker-close-",
    );
    const imagePath = join(directory, "image.fi");
    await writeFile(imagePath, buildFv({ files: [driver] }).buffer);
    const controller = new AbortController();
    const stopProcess = ProviderProcessSupervisor.prototype.stop;
    const stopping = vi
      .spyOn(ProviderProcessSupervisor.prototype, "stop")
      .mockImplementationOnce(async function (this: ProviderProcessSupervisor) {
        controller.abort("cancelled during worker close");
        return stopProcess.call(this);
      });
    const provider = new UefiAnalysisProvider(distUefiLzmaWorker);
    try {
      const result = await provider.execute(inspectRequest(imagePath), {
        signal: controller.signal,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error._tag).toBe("AnalysisCancelledError");
        expect(result.error.cleanupIncomplete).toBe(false);
        expect(result.error.partialObservation).toMatchObject({
          kind: "uefi",
          result: {
            firmware_volumes: [
              expect.objectContaining({
                ffs_files: [expect.objectContaining({ guid: GUID_DRIVER })],
              }),
            ],
          },
          provenance: {
            path: imagePath,
          },
        });
      }
    } finally {
      stopping.mockRestore();
      await provider.close();
    }
  },
  45_000,
);

it.skipIf(!lzmaWorkerAvailable)(
  "reuses one persistent LZMA worker across multiple sections and reuses the validated scan for extraction",
  async () => {
    const mod1 = buildSection(0x10, Buffer.from("DXE-DRIVER-ONE-PAYLOAD"));
    const mod2 = buildSection(0x10, Buffer.from("DXE-DRIVER-TWO-PAYLOAD"));
    const corrupt = Buffer.from([0x5d, 0x00, 0x00, 0x80, 0x00, 0xaa, 0xbb]);
    const f1 = buildFfsFile({
      guid: GUID_DRIVER,
      typeCode: 7,
      payload: buildLzmaGuidedSection(
        Buffer.from(lzmaPurescript.compressFile(mod1)),
      ),
    });
    const fBad = buildFfsFile({
      guid: "55555555-6666-4777-8888-999999999999",
      typeCode: 7,
      payload: buildLzmaGuidedSection(corrupt),
    });
    const f2 = buildFfsFile({
      guid: GUID_RAW,
      typeCode: 7,
      payload: buildLzmaGuidedSection(
        Buffer.from(lzmaPurescript.compressFile(mod2)),
      ),
    });
    const directory = await createTestTempDirectory("rea-uefi-worker-pool-");
    const imagePath = join(directory, "multi-lzma.fd");
    await writeFile(imagePath, buildFv({ files: [f1, fBad, f2] }).buffer);

    let lzmaRootsCreated = 0;
    const create = PrivateRuntimeRoot.create;
    const creating = vi
      .spyOn(PrivateRuntimeRoot, "create")
      .mockImplementation(async (options) => {
        if (options?.prefix === "rea-uefi-lzma-") lzmaRootsCreated += 1;
        return create(options);
      });
    const provider = new UefiAnalysisProvider(distUefiLzmaWorker);
    try {
      const inspected = expectOk(
        await provider.execute(inspectRequest(imagePath)),
      ).value.result as UefiInspectResult;
      expect(lzmaRootsCreated).toBe(1);
      expect(inspected.coverage).toBe("partial");

      const extracted = expectOk(
        await provider.execute(
          extractRequest(imagePath, join(directory, "out"), {
            include_compressed: false,
          }),
        ),
      ).value.result as UefiExtractResult;
      // Validated scan summary is reused across inspect -> extract without spawning another worker.
      expect(lzmaRootsCreated).toBe(1);
      expect(
        extracted.files
          .filter((entry) => entry.source === "raw-section")
          .map((entry) => entry.sha256),
      ).toEqual([
        sha256(Buffer.from("DXE-DRIVER-ONE-PAYLOAD")),
        sha256(Buffer.from("DXE-DRIVER-TWO-PAYLOAD")),
      ]);
    } finally {
      creating.mockRestore();
      await provider.close();
    }
  },
  45_000,
);

it("keeps worker stdin errors owned across cancellation of an in-flight frame write", async () => {
  const directory = await createTestTempDirectory("rea-uefi-stdin-cancel-");
  const blockedWorker = join(directory, "blocked-worker.mjs");
  await writeFile(blockedWorker, "setInterval(() => {}, 1000);\n", "utf8");
  const largeCompressed = Buffer.alloc(512 * 1024, 0x5d);
  const ffs = buildFfsFile({
    guid: GUID_DRIVER,
    typeCode: 7,
    payload: buildLzmaGuidedSection(largeCompressed),
  });
  const imagePath = join(directory, "large-lzma.fd");
  await writeFile(imagePath, buildFv({ files: [ffs] }).buffer);

  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => {
    uncaught.push(err);
  };
  process.on("uncaughtException", onUncaught);

  const controller = new AbortController();
  let capturedStdin: NodeJS.WritableStream | undefined;
  const stop = ProviderProcessSupervisor.prototype.stop;
  const stopping = vi
    .spyOn(ProviderProcessSupervisor.prototype, "stop")
    .mockImplementation(async function (this: ProviderProcessSupervisor) {
      capturedStdin = this.launch.process.stdin ?? undefined;
      capturedStdin?.emit(
        "error",
        Object.assign(new Error("write EPIPE during stop"), { code: "EPIPE" }),
      );
      return stop.call(this);
    });

  const provider = new UefiAnalysisProvider(blockedWorker);
  try {
    const timer = setTimeout(() => {
      controller.abort(new Error("caller cancelled write"));
    }, 120);
    const result = await provider.execute(inspectRequest(imagePath), {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (capturedStdin !== undefined) {
      capturedStdin.emit(
        "error",
        Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
      );
    }
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe("AnalysisCancelledError");
    }
    expect(uncaught).toEqual([]);
  } finally {
    stopping.mockRestore();
    process.off("uncaughtException", onUncaught);
    await provider.close();
  }
});

it("preserves caller cancellation and cleans up the runtime root when worker startup aborts before launch", async () => {
  const directory = await createTestTempDirectory("rea-uefi-startup-cancel-");
  const ffs = buildFfsFile({
    guid: GUID_DRIVER,
    typeCode: 7,
    payload: buildLzmaGuidedSection(
      Buffer.from([0x5d, 0x00, 0x00, 0x80, 0x00]),
    ),
  });
  const imagePath = join(directory, "startup-cancel.fd");
  await writeFile(imagePath, buildFv({ files: [ffs] }).buffer);

  const controller = new AbortController();
  const createRoot = PrivateRuntimeRoot.create.bind(PrivateRuntimeRoot);
  let createdRootPath: string | undefined;
  const creating = vi
    .spyOn(PrivateRuntimeRoot, "create")
    .mockImplementationOnce(async (options) => {
      const root = await createRoot(options);
      createdRootPath = root.path;
      controller.abort("caller cancelled during startup");
      return root;
    });
  const provider = new UefiAnalysisProvider();
  try {
    const result = await provider.execute(inspectRequest(imagePath), {
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe("AnalysisCancelledError");
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(result.error.secondaryFailures).toEqual([]);
    }
    expect(createdRootPath).toBeDefined();
    expect(existsSync(createdRootPath!)).toBe(false);
  } finally {
    creating.mockRestore();
    await provider.close();
  }
});

it("preserves provider_timeout and cleans up the runtime root when the deadline expires during worker startup", async () => {
  const directory = await createTestTempDirectory("rea-uefi-startup-timeout-");
  const ffs = buildFfsFile({
    guid: GUID_DRIVER,
    typeCode: 7,
    payload: buildLzmaGuidedSection(
      Buffer.from([0x5d, 0x00, 0x00, 0x80, 0x00]),
    ),
  });
  const imagePath = join(directory, "startup-timeout.fd");
  await writeFile(imagePath, buildFv({ files: [ffs] }).buffer);

  const createRoot = PrivateRuntimeRoot.create.bind(PrivateRuntimeRoot);
  let createdRootPath: string | undefined;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const creating = vi
    .spyOn(PrivateRuntimeRoot, "create")
    .mockImplementationOnce(async (options) => {
      const root = await createRoot(options);
      createdRootPath = root.path;
      vi.advanceTimersByTime(UEFI_FIRMWARE_LIMITS.timeoutMs);
      return root;
    });
  const provider = new UefiAnalysisProvider();
  try {
    const result = await provider.execute(inspectRequest(imagePath));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        _tag: "AnalysisTimeoutError",
        timeoutMs: UEFI_FIRMWARE_LIMITS.timeoutMs,
      });
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(result.error.secondaryFailures).toEqual([]);
    }
    expect(createdRootPath).toBeDefined();
    expect(existsSync(createdRootPath!)).toBe(false);
  } finally {
    creating.mockRestore();
    vi.useRealTimers();
    await provider.close();
  }
});

it("rolls back a tree acquired during failed publication setup without publishing", async () => {
  const { imagePath, directory } = await writeTestImage();
  const provider = new UefiAnalysisProvider();
  const output = join(directory, "out");
  const create = SafeOutputTree.create.bind(SafeOutputTree);
  const creation = vi
    .spyOn(SafeOutputTree, "create")
    .mockImplementationOnce(async (path) => {
      throw new SafeOutputTreeCreationFailure(
        new Error("setup failed"),
        await create(path),
      );
    });
  try {
    const result = await provider.execute(extractRequest(imagePath, output));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.diagnostics?.reason).toBe("setup failed");
    expect(existsSync(output)).toBe(false);
  } finally {
    creation.mockRestore();
    await provider.close();
  }
});

it("waits for committed output finalization during late cancellation and retries retained cleanup", async () => {
  const { imagePath, directory } = await writeTestImage({ withGuided: false });
  const provider = new UefiAnalysisProvider();
  const output = join(directory, "out");
  const controller = new AbortController();
  const committed = createDeferred<void>();
  const releaseFinalization = createDeferred<void>();
  const commit = SafeOutputTree.prototype.commit;
  const committing = vi
    .spyOn(SafeOutputTree.prototype, "commit")
    .mockImplementationOnce(async function (this: SafeOutputTree, signal) {
      await commit.call(this, signal);
      committed.resolve();
      await releaseFinalization.promise;
      throw new Error("commit handle close failed");
    });
  const rollback = vi
    .spyOn(SafeOutputTree.prototype, "rollback")
    .mockRejectedValueOnce(new Error("close still denied"));
  try {
    let settled = false;
    const executing = provider
      .execute(extractRequest(imagePath, output), { signal: controller.signal })
      .finally(() => {
        settled = true;
      });
    await committed.promise;
    const queued = new AbortController();
    const queuedWork = provider.execute(inspectRequest(imagePath), {
      signal: queued.signal,
    });
    queued.abort("queued stop");
    const queuedResult = await queuedWork;
    expect(queuedResult).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError", cause: "queued stop" },
    });
    controller.abort("late stop");
    const closing = provider.close();
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseFinalization.resolve();
    const result = await executing;
    expect(result).toMatchObject({
      ok: false,
      error: {
        partialObservation: {
          kind: "uefi",
          result: {
            output_directory: expect.any(String),
            published_bytes: MODULE_A.length + RAW_BODY.length,
          },
        },
      },
    });
    await closing;
    expect(rollback).toHaveBeenCalledTimes(2);
    if (!result.ok) expect(result.error.cleanupIncomplete).toBe(false);
    expect(existsSync(output)).toBe(true);
  } finally {
    releaseFinalization.resolve();
    committing.mockRestore();
    rollback.mockRestore();
    await provider.close();
  }
});

it("preserves the timeout and failed rollback when the deadline expires before commit", async () => {
  const { imagePath, directory } = await writeTestImage({ withGuided: false });
  const provider = new UefiAnalysisProvider();
  const output = join(directory, "out");
  const write = SafeOutputTree.prototype.write;
  let expiredClock: ReturnType<typeof vi.spyOn> | undefined;
  const writing = vi
    .spyOn(SafeOutputTree.prototype, "write")
    .mockImplementationOnce(async function (this: SafeOutputTree, ...args) {
      const receipt = await write.apply(this, args);
      const afterDeadline = performance.now() + UEFI_FIRMWARE_LIMITS.timeoutMs;
      expiredClock = vi
        .spyOn(performance, "now")
        .mockReturnValue(afterDeadline);
      return receipt;
    });
  const rollback = vi
    .spyOn(SafeOutputTree.prototype, "rollback")
    .mockRejectedValueOnce(new Error("rollback denied"));
  try {
    const result = await provider.execute(extractRequest(imagePath, output));
    expect(result).toMatchObject({
      ok: false,
      error: {
        cleanupIncomplete: true,
        cleanupPrimary: {
          _tag: "AnalysisTimeoutError",
          timeoutMs: UEFI_FIRMWARE_LIMITS.timeoutMs,
        },
      },
    });
    await provider.close();
    expect(rollback).toHaveBeenCalledTimes(2);
    expect(existsSync(output)).toBe(false);
  } finally {
    expiredClock?.mockRestore();
    writing.mockRestore();
    rollback.mockRestore();
    await provider.close();
  }
});

it.each([
  ["unrecognized", Buffer.from("unrecognized flash bytes")],
  ["erased", Buffer.alloc(64, 0xff)],
])(
  "reports a full-range gap for a %s image without volumes",
  async (_name, bytes) => {
    const directory = await createTestTempDirectory("rea-uefi-unparsed-");
    const path = join(directory, "image.fd");
    await writeFile(path, bytes);
    const provider = new UefiAnalysisProvider();
    try {
      const request = extractRequest(path, join(directory, "out"));
      const result = expectOk(await provider.execute(request)).value
        .result as UefiExtractResult;
      expect(result).toMatchObject({
        coverage: "partial",
        files: [],
        extraction_gaps: [
          {
            kind: "unparsed-region",
            logical_path: "flash",
            source_stream: null,
            range: { offset: 0, length: bytes.length },
          },
        ],
      });
    } finally {
      await provider.close();
    }
  },
);

it("scopes a short non-erased FFS suffix to its own volume", async () => {
  const raw = buildFfsFile({
    guid: GUID_RAW,
    typeCode: 1,
    payload: Buffer.alloc(3992, 0x42),
  });
  const damaged = buildFv({ files: [raw] }).buffer;
  damaged.fill(0x22, 0xff8);
  const sibling = buildFv({
    files: [
      buildFfsFile({
        guid: GUID_DRIVER,
        typeCode: 7,
        payload: buildSection(0x10, MODULE_A),
      }),
    ],
  }).buffer;
  const directory = await createTestTempDirectory("rea-uefi-scoped-tail-");
  const path = join(directory, "image.fd");
  await writeFile(path, Buffer.concat([damaged, sibling]));

  const provider = new UefiAnalysisProvider();
  try {
    const extract = async (name: string, offset: number) =>
      expectOk(
        await provider.execute(
          extractRequest(path, join(directory, name), {
            target: { kind: "volume", offset },
          }),
        ),
      ).value.result as UefiExtractResult;
    const intact = await extract("sibling", 0x1000);
    expect(intact.coverage).toBe("complete");
    expect(intact.extraction_gaps).toEqual([]);
    expect(intact.files.map(({ sha256 }) => sha256)).toEqual([
      sha256(MODULE_A),
    ]);

    const parsed = await extract("damaged", 0);
    expect(parsed.coverage).toBe("partial");
    expect(parsed.extraction_gaps).toMatchObject([
      {
        kind: "unparsed-region",
        logical_path: "flash/FV@0x0",
        source_stream: null,
        range: { offset: 0xff8, length: 8 },
      },
    ]);
  } finally {
    await provider.close();
  }
});

it("reports an incomplete section suffix for the containing file", async () => {
  const section = buildSection(0x10, MODULE_A);
  const file = buildFfsFile({
    guid: GUID_DRIVER,
    typeCode: 7,
    payload: Buffer.concat([section, Buffer.from([0x12, 0x34])]),
  });
  const fv = buildFv({ files: [file] });
  const directory = await createTestTempDirectory("rea-uefi-scoped-section-");
  const path = join(directory, "image.fd");
  await writeFile(path, fv.buffer);

  const provider = new UefiAnalysisProvider();
  try {
    const result = expectOk(
      await provider.execute(
        extractRequest(path, join(directory, "file"), {
          target: { kind: "ffs-file", offset: fv.headerLength },
        }),
      ),
    ).value.result as UefiExtractResult;
    expect(result.coverage).toBe("partial");
    expect(result.files.map(({ sha256 }) => sha256)).toEqual([
      sha256(MODULE_A),
    ]);
    expect(result.extraction_gaps).toMatchObject([
      {
        kind: "unparsed-region",
        source_stream: null,
        range: { offset: fv.headerLength + 24 + section.length, length: 2 },
      },
    ]);
  } finally {
    await provider.close();
  }
});

it("limits coverage to the section that contains depth-limited children", async () => {
  const raw = buildSection(0x10, MODULE_A);
  const nested = buildSection(0x03, buildSection(0x03, raw));
  const driver = buildFfsFile({
    guid: GUID_DRIVER,
    typeCode: 7,
    payload: Buffer.concat([raw, nested]),
  });
  const fv = buildFv({ files: [driver] });
  const directory = await createTestTempDirectory("rea-uefi-scoped-depth-");
  const path = join(directory, "image.fd");
  await writeFile(path, fv.buffer);

  const provider = new UefiAnalysisProvider();
  try {
    const extract = async (
      name: string,
      target: Extract<
        UefiRequest,
        { operation: "extract_uefi_firmware" }
      >["input"]["target"],
    ) =>
      expectOk(
        await provider.execute(
          extractRequest(path, join(directory, name), {
            max_depth: 1,
            target,
          }),
        ),
      ).value.result as UefiExtractResult;
    const offset = fv.headerLength + 24;
    const sibling = await extract("sibling", { kind: "section", offset });
    expect(sibling.coverage).toBe("complete");
    expect(sibling.extraction_gaps).toEqual([]);
    const enclosing = await extract("enclosed", {
      kind: "section",
      offset: offset + raw.length,
    });
    expect(enclosing.coverage).toBe("partial");
    expect(enclosing.extraction_gaps).toMatchObject([
      {
        kind: "depth-limited",
        source_stream: null,
        range: { offset: offset + raw.length + 8, length: raw.length },
      },
    ]);
  } finally {
    await provider.close();
  }
});

it("maps a decoded FV-image section and its PE32 sibling in the original chain", async () => {
  const embedded = buildSection(0x17, buildFv({ files: [] }).buffer);
  const peerBytes = Buffer.from("independently selectable PE32 body");
  const decoded = Buffer.concat([embedded, buildSection(0x10, peerBytes)]);
  const file = buildFfsFile({
    guid: GUID_DRIVER,
    typeCode: 7,
    payload: amdZlibSection(decoded),
  });
  const directory = await createTestTempDirectory(
    "rea-uefi-mixed-decoded-chain-",
  );
  const path = join(directory, "image.fd");
  await writeFile(path, buildFv({ files: [file] }).buffer);

  const provider = new UefiAnalysisProvider();
  try {
    const inspection = expectOk(await provider.execute(inspectRequest(path)))
      .value.result as UefiInspectResult;
    const outer = inspection.firmware_volumes[0]?.ffs_files[0]?.sections;
    const embeddedSection = outer?.find(({ type_code }) => type_code === 0x17);
    const pe = outer?.find(({ type_code }) => type_code === 0x10);
    expect(embeddedSection?.sub_volumes).toEqual([
      inspection.firmware_volumes[1]?.logical_path,
    ]);
    expect(pe).toMatchObject({
      offset: embedded.length,
      source_stream: outer?.[0]?.logical_path,
    });
    expect(inspection.coverage).toBe("complete");
    if (pe === undefined) throw new Error("decoded sibling was lost");

    const extraction = expectOk(
      await provider.execute(
        extractRequest(path, join(directory, "out"), {
          target: {
            kind: "section",
            offset: embedded.length,
            source_stream: pe.source_stream,
          },
        }),
      ),
    ).value.result as UefiExtractResult;
    expect(extraction.coverage).toBe("complete");
    expect(extraction.extraction_gaps).toEqual([]);
    expect(extraction.files).toMatchObject([
      {
        sha256: sha256(peerBytes),
        source_stream: pe.source_stream,
        source_range: { offset: embedded.length + 4, length: peerBytes.length },
      },
    ]);
  } finally {
    await provider.close();
  }
});

it("uses common-header framing for an unknown decoded section and keeps its PE32 sibling selectable", async () => {
  const unknown = buildSection(0x80, Buffer.from("vendor record"));
  const pe = buildSection(0x10, MODULE_A);
  const suffix = Buffer.from([0x12, 0x34]);
  const file = buildFfsFile({
    guid: GUID_DRIVER,
    typeCode: 7,
    payload: amdZlibSection(Buffer.concat([unknown, pe, suffix])),
  });
  const directory = await createTestTempDirectory("rea-uefi-unknown-frame-");
  const path = join(directory, "image.fd");
  await writeFile(path, buildFv({ files: [file] }).buffer);

  const provider = new UefiAnalysisProvider();
  try {
    const inspected = expectOk(await provider.execute(inspectRequest(path)))
      .value.result as UefiInspectResult;
    const sections = inspected.firmware_volumes[0]?.ffs_files[0]?.sections;
    expect(sections?.slice(1)).toMatchObject([
      { type_code: 0x80, type_name: "unknown", offset: 0 },
      { type_code: 0x10, type_name: "pe32", offset: unknown.length },
    ]);
    expect(inspected.coverage).toBe("partial");
    const source = sections?.[0]?.logical_path;
    if (source === undefined) throw new Error("decoded source was lost");

    const selected = expectOk(
      await provider.execute(
        extractRequest(path, join(directory, "pe"), {
          target: {
            kind: "section",
            offset: unknown.length,
            source_stream: source,
          },
        }),
      ),
    ).value.result as UefiExtractResult;
    expect(selected.coverage).toBe("complete");
    expect(selected.files).toMatchObject([{ sha256: sha256(MODULE_A) }]);

    const whole = expectOk(
      await provider.execute(extractRequest(path, join(directory, "whole"))),
    ).value.result as UefiExtractResult;
    expect(whole.extraction_gaps).toMatchObject([
      {
        kind: "unparsed-region",
        source_stream: source,
        range: { offset: unknown.length + pe.length, length: suffix.length },
      },
    ]);
  } finally {
    await provider.close();
  }
});

it.each([
  {
    name: "GUID-defined",
    declaredLength: 24,
    buildMalformedSection: () => {
      const section = buildGuidedSection({
        definitionGuid: GUID_GUIDED,
        body: Buffer.alloc(0),
      });
      section.writeUInt16LE(20, 20);
      return section;
    },
  },
  {
    name: "compression",
    declaredLength: 9,
    buildMalformedSection: () => buildCompressionSection(Buffer.alloc(0), 0, 1),
  },
])(
  "retains decoded siblings after a malformed $name section",
  async ({ buildMalformedSection, declaredLength }) => {
    const malformed = buildMalformedSection();
    const file = buildFfsFile({
      guid: GUID_DRIVER,
      typeCode: 7,
      payload: amdZlibSection(
        Buffer.concat([malformed, buildSection(0x10, MODULE_A)]),
      ),
    });
    const directory = await createTestTempDirectory(
      "rea-uefi-malformed-frame-",
    );
    const path = join(directory, "image.fd");
    await writeFile(path, buildFv({ files: [file] }).buffer);

    const provider = new UefiAnalysisProvider();
    try {
      const inspected = expectOk(await provider.execute(inspectRequest(path)))
        .value.result as UefiInspectResult;
      const sections = inspected.firmware_volumes[0]?.ffs_files[0]?.sections;
      const source = sections?.[0]?.logical_path;
      if (source === undefined) throw new Error("decoded source was lost");
      expect(inspected.coverage).toBe("partial");
      expect(sections?.slice(1)).toMatchObject([
        { offset: 0, malformed: true, source_stream: source },
        { offset: malformed.length, type_name: "pe32", source_stream: source },
      ]);

      const whole = expectOk(
        await provider.execute(extractRequest(path, join(directory, "whole"))),
      ).value.result as UefiExtractResult;
      expect(whole.extraction_gaps).toMatchObject([
        {
          kind: "unparsed-region",
          source_stream: source,
          range: { offset: 0, length: declaredLength },
        },
      ]);

      const selected = expectOk(
        await provider.execute(
          extractRequest(path, join(directory, "pe"), {
            target: {
              kind: "section",
              offset: malformed.length,
              source_stream: source,
            },
          }),
        ),
      ).value.result as UefiExtractResult;
      expect(selected.coverage).toBe("complete");
      expect(selected.extraction_gaps).toEqual([]);
      expect(selected.files).toMatchObject([{ sha256: sha256(MODULE_A) }]);
    } finally {
      await provider.close();
    }
  },
);

const verifyOutputLimitCoverage = async (
  section: Buffer,
  workerPath?: string,
) => {
  const file = buildFfsFile({
    guid: GUID_DRIVER,
    typeCode: 7,
    payload: section,
  });
  const vol = buildFv({ files: [file] });
  const directory = await createTestTempDirectory("rea-uefi-decode-limit-");
  const path = join(directory, "image.fd");
  await writeFile(path, vol.buffer);
  const provider = new UefiAnalysisProvider(workerPath);
  try {
    const inspected = expectOk(await provider.execute(inspectRequest(path)))
      .value.result as UefiInspectResult;
    expect(inspected.coverage).toBe("partial");
    const extracted = expectOk(
      await provider.execute(
        extractRequest(path, join(directory, "out"), {
          include_compressed: false,
        }),
      ),
    ).value.result as UefiExtractResult;
    expect(extracted.coverage).toBe("partial");
    expect(extracted.files).toEqual([]);
    expect(extracted.extraction_gaps).toMatchObject([
      {
        kind: "size-truncated",
        source_stream: null,
        detail: expect.stringMatching(/exceeds.*bytes/u),
      },
    ]);
  } finally {
    await provider.close();
  }
};

it("keeps a real zlib output-limit failure distinct from unsupported compression", async () => {
  const bytes = Buffer.alloc(UEFI_FIRMWARE_LIMITS.lzmaOutputBytes + 1);
  buildFv({ files: [] }).buffer.copy(bytes);
  await verifyOutputLimitCoverage(amdZlibSection(bytes));
});

it.skipIf(!lzmaWorkerAvailable)(
  "keeps the owned LZMA worker's declared output limit across its reply boundary",
  async () => {
    const header = Buffer.alloc(13);
    header[0] = 0x5d;
    header.writeUInt32LE(4096, 1);
    header.writeBigUInt64LE(
      BigInt(UEFI_FIRMWARE_LIMITS.lzmaOutputBytes + 1),
      5,
    );
    await verifyOutputLimitCoverage(
      buildLzmaGuidedSection(header),
      distUefiLzmaWorker,
    );
  },
);

it("extracts directly readable guided children regardless of a compression passthrough choice", async () => {
  const child = buildSection(0x19, MODULE_A);
  const crc = buildGuidedSection({
    definitionGuid: "fc1bcdb0-7d31-49aa-936a-a4600d9dd083",
    body: child,
    dataOffset: 28,
    attributes: 2,
  });
  const ordinary = buildGuidedSection({
    definitionGuid: GUID_GUIDED,
    body: child,
  });
  const file = buildFfsFile({
    guid: GUID_DRIVER,
    typeCode: 7,
    payload: Buffer.concat([crc, ordinary]),
  });
  const directory = await createTestTempDirectory("rea-uefi-guided-stored-");
  const path = join(directory, "image.fd");
  await writeFile(path, buildFv({ files: [file] }).buffer);
  const provider = new UefiAnalysisProvider();
  try {
    const inspected = expectOk(await provider.execute(inspectRequest(path)))
      .value.result as UefiInspectResult;
    expect(inspected.coverage).toBe("complete");
    expect(
      inspected.firmware_volumes[0]?.ffs_files[0]?.sections.map(
        ({ type_name, compression }) => [type_name, compression.kind],
      ),
    ).toEqual([
      ["guid-defined", "crc32-guided"],
      ["raw", "none"],
      ["guid-defined", "unknown-guid"],
      ["raw", "none"],
    ]);
    const result = expectOk(
      await provider.execute(
        extractRequest(path, join(directory, "out"), {
          include_compressed: false,
        }),
      ),
    ).value.result as UefiExtractResult;
    expect(result.extraction_gaps).toEqual([]);
    expect(result.files).toMatchObject([
      { source: "raw-section", sha256: sha256(MODULE_A) },
      { source: "raw-section", sha256: sha256(MODULE_A) },
    ]);
  } finally {
    await provider.close();
  }
});

it("publishes typed leaf payloads without their headers and scopes nonzero alignment bytes", async () => {
  const guid = guidBytes(GUID_GUIDED);
  const freeformPayload = Buffer.from([0x61]);
  const versionPayload = Buffer.from("v\0", "utf16le");
  const freeform = buildSection(0x18, Buffer.concat([guid, freeformPayload]));
  freeform.fill(0x77, 21);
  const version = buildSection(
    0x14,
    Buffer.concat([Buffer.from([0x34, 0x12]), versionPayload]),
  );
  const file = buildFfsFile({
    guid: GUID_DRIVER,
    typeCode: 7,
    payload: Buffer.concat([freeform, version]),
  });
  const fv = buildFv({ files: [file] });
  const directory = await createTestTempDirectory("rea-uefi-leaf-header-");
  const path = join(directory, "image.fd");
  await writeFile(path, fv.buffer);
  const provider = new UefiAnalysisProvider();
  try {
    const inspected = expectOk(await provider.execute(inspectRequest(path)))
      .value.result as UefiInspectResult;
    expect(inspected.firmware_volumes[0]?.ffs_files[0]?.sections).toMatchObject(
      [
        { type_name: "freeform-subtype-guid", header_length: 20 },
        { type_name: "version", header_length: 6 },
      ],
    );
    const result = expectOk(
      await provider.execute(extractRequest(path, join(directory, "out"))),
    ).value.result as UefiExtractResult;
    expect(result.files).toMatchObject([
      {
        source_range: { offset: 116, length: 1 },
        sha256: sha256(freeformPayload),
      },
      {
        source_range: { offset: 126, length: 4 },
        sha256: sha256(versionPayload),
      },
    ]);
    expect(result.extraction_gaps).toMatchObject([
      { kind: "unparsed-region", range: { offset: 117, length: 3 } },
    ]);
  } finally {
    await provider.close();
  }
});

it.each([
  {
    name: "empty carrier",
    section: buildGuidedSection({
      definitionGuid: GUID_AMD_ZLIB,
      body: Buffer.alloc(0),
    }),
    message: "Empty zlib carrier",
  },
  {
    name: "unconsumed suffix",
    section: amdZlibSection(
      buildSection(0x19, MODULE_A),
      Buffer.from("ordinary trailing bytes"),
    ),
    message: "declared compressed bytes",
  },
])(
  "reports partial inspection and extraction for a supported codec with $name",
  async ({ section, message }) => {
    const file = buildFfsFile({
      guid: GUID_DRIVER,
      typeCode: 7,
      payload: section,
    });
    const directory = await createTestTempDirectory("rea-uefi-codec-input-");
    const path = join(directory, "image.fd");
    await writeFile(path, buildFv({ files: [file] }).buffer);
    const provider = new UefiAnalysisProvider();
    try {
      const inspected = expectOk(await provider.execute(inspectRequest(path)))
        .value.result as UefiInspectResult;
      expect(inspected.coverage).toBe("partial");
      expect(inspected.limitations.join(" ")).toContain(message);
      const result = expectOk(
        await provider.execute(
          extractRequest(path, join(directory, "out"), {
            include_compressed: false,
          }),
        ),
      ).value.result as UefiExtractResult;
      expect(result.derivations).toEqual([]);
      expect(result.files).toEqual([]);
      expect(result.extraction_gaps).toMatchObject([
        { kind: "unparsed-region", detail: expect.stringContaining(message) },
      ]);
    } finally {
      await provider.close();
    }
  },
);

it.each(["standalone", "pad-file"] as const)(
  "walks FFS after a %s FV extension and preserves a sibling after an invalid header",
  async (extendedHeader) => {
    const invalid = buildFfsFile({
      guid: GUID_DRIVER,
      typeCode: 1,
      payload: Buffer.alloc(104),
    }).subarray(0, 24);
    invalid[23] = 0x1f; // Effective HEADER_INVALID with erase polarity one.
    const sibling = buildFfsFile({
      guid: GUID_RAW,
      typeCode: 1,
      payload: RAW_BODY,
    });
    const fv = buildFv({ files: [invalid, sibling], extendedHeader });
    const invalidOffset = extendedHeader === "standalone" ? 104 : 128;
    const directory = await createTestTempDirectory(
      "rea-uefi-ffs-after-metadata-",
    );
    const path = join(directory, "image.fd");
    await writeFile(path, fv.buffer);
    const provider = new UefiAnalysisProvider();
    try {
      const inspected = expectOk(await provider.execute(inspectRequest(path)))
        .value.result as UefiInspectResult;
      const files = inspected.firmware_volumes[0]?.ffs_files;
      expect(
        files?.map(({ type_name, offset, length }) => [
          type_name,
          offset,
          length,
        ]),
      ).toEqual([
        ...(extendedHeader === "pad-file" ? [["pad", 72, 52]] : []),
        ["raw", invalidOffset, 24],
        ["raw", invalidOffset + 24, sibling.length],
      ]);
      const result = expectOk(
        await provider.execute(extractRequest(path, join(directory, "out"))),
      ).value.result as UefiExtractResult;
      expect(result.files).toMatchObject([
        {
          sha256: sha256(RAW_BODY),
          source_range: { offset: invalidOffset + 48, length: RAW_BODY.length },
        },
      ]);
      expect(
        result.extraction_gaps.filter(({ kind }) => kind !== "pad-file"),
      ).toMatchObject([
        {
          kind: "unparsed-region",
          range: { offset: invalidOffset, length: 24 },
        },
      ]);
    } finally {
      await provider.close();
    }
  },
);

it.each([
  { checksum: 0, entryBasis: "scanned" },
  { checksum: 0x000c0001, entryBasis: "amd-psp-first" },
])(
  "uses a PSP directory for image provenance only after verifying its checksum ($entryBasis)",
  async ({ checksum, entryBasis }) => {
    const prefix = Buffer.alloc(0x1000, 0);
    prefix.write("$PL2", 0, "ascii");
    prefix.writeUInt32LE(checksum, 4);
    prefix.writeUInt32LE(1, 8);
    const directory = await createTestTempDirectory("rea-uefi-psp-basis-");
    const path = join(directory, "image.fd");
    await writeFile(
      path,
      Buffer.concat([prefix, buildFv({ files: [] }).buffer]),
    );
    const provider = new UefiAnalysisProvider();
    try {
      const result = expectOk(await provider.execute(inspectRequest(path)))
        .value.result as UefiInspectResult;
      expect(result.flash_image.entry_basis).toBe(entryBasis);
      expect(result.firmware_volumes[0]?.offset).toBe(prefix.length);
      if (checksum === 0)
        expect(result.psp_candidates).toMatchObject([
          { reason: "checksum-mismatch" },
        ]);
      else
        expect(result.psp_tables).toMatchObject([
          {
            table_magic: "$PL2",
            entries: [{ location_basis: "declared-unverified" }],
          },
        ]);
    } finally {
      await provider.close();
    }
  },
);

it("retains a signed guided section as opaque when its processing flag is clear", async () => {
  const child = buildSection(0x19, Buffer.from("stored data"));
  const section = buildGuidedSection({
    definitionGuid: "0f9d89e8-9259-4f76-a5af-0c89e34023df",
    body: child,
    attributes: 0,
  });
  const file = buildFfsFile({
    guid: GUID_DRIVER,
    typeCode: 7,
    payload: section,
  });
  const directory = await createTestTempDirectory("rea-uefi-signed-opaque-");
  const path = join(directory, "image.fd");
  await writeFile(path, buildFv({ files: [file] }).buffer);
  const provider = new UefiAnalysisProvider();
  try {
    const inspected = expectOk(await provider.execute(inspectRequest(path)))
      .value.result as UefiInspectResult;
    expect(inspected.coverage).toBe("partial");
    expect(
      inspected.firmware_volumes[0]?.ffs_files[0]?.sections.map(
        ({ type_name }) => type_name,
      ),
    ).toEqual(["guid-defined"]);
    const extracted = expectOk(
      await provider.execute(
        extractRequest(path, join(directory, "out"), {
          include_compressed: false,
        }),
      ),
    ).value.result as UefiExtractResult;
    expect(extracted.files).toEqual([]);
    expect(extracted.extraction_gaps).toMatchObject([
      {
        kind: "unknown-guid-handler",
        range: { offset: 120, length: child.length },
      },
    ]);
  } finally {
    await provider.close();
  }
});

it.each([
  { erase: 0xff as const, dirty: 0x00 },
  { erase: 0x00 as const, dirty: 0xff },
])(
  "reports inter-file bytes that differ from erase polarity $erase",
  async ({ erase, dirty }) => {
    const first = buildFfsFile({
      guid: GUID_DRIVER,
      typeCode: 1,
      payload: Buffer.from([1]),
      erasePolarity: erase === 0xff,
    });
    const second = buildFfsFile({
      guid: GUID_RAW,
      typeCode: 1,
      payload: RAW_BODY,
      erasePolarity: erase === 0xff,
    });
    const image = buildFv({ files: [first, second], erase }).buffer;
    image.fill(dirty, 97, 104);
    const directory = await createTestTempDirectory(
      "rea-uefi-inter-file-padding-",
    );
    const path = join(directory, "image.fd");
    await writeFile(path, image);
    const provider = new UefiAnalysisProvider();
    try {
      const inspected = expectOk(await provider.execute(inspectRequest(path)))
        .value.result as UefiInspectResult;
      expect(
        inspected.firmware_volumes[0]?.ffs_files.map(({ offset }) => offset),
      ).toEqual([72, 104]);
      expect(inspected.coverage).toBe("partial");
      expect(
        inspected.unknown_regions.find(({ offset }) => offset === 97),
      ).toMatchObject({
        offset: 97,
        length: 7,
        erasure: "none",
        sha256: sha256(Buffer.alloc(7, dirty)),
      });
      const whole = expectOk(
        await provider.execute(extractRequest(path, join(directory, "whole"))),
      ).value.result as UefiExtractResult;
      expect(whole.extraction_gaps).toMatchObject([
        {
          kind: "unparsed-region",
          range: { offset: 97, length: 7 },
          logical_path: "flash/FV@0x0",
        },
      ]);
      const selected = expectOk(
        await provider.execute(
          extractRequest(path, join(directory, "file"), {
            target: { kind: "ffs-file", offset: 104 },
          }),
        ),
      ).value.result as UefiExtractResult;
      expect(selected.coverage).toBe("complete");
      expect(selected.files).toMatchObject([{ sha256: sha256(RAW_BODY) }]);
    } finally {
      await provider.close();
    }
  },
);

it.each([
  {
    name: "valid unaligned UsedSize",
    entrySize: 8,
    usedSize: 129,
    range: null,
  },
  {
    name: "zero-sized entry",
    entrySize: 0,
    usedSize: 129,
    range: { offset: 92, length: 8 },
    detail: "invalid extent",
  },
  {
    name: "entry exceeding the extension",
    entrySize: 9,
    usedSize: 129,
    range: { offset: 92, length: 8 },
    detail: "invalid extent",
  },
  {
    name: "UsedSize before the extension ends",
    entrySize: 8,
    usedSize: 99,
    range: { offset: 96, length: 4 },
    detail: "outside the volume data extent",
  },
  {
    name: "file in the claimed erased tail",
    entrySize: 8,
    usedSize: 104,
    range: { offset: 96, length: 4 },
    detail: "ends before the observed FFS file end at 0x81",
  },
  {
    name: "UsedSize inside the erase-filled end of a file",
    entrySize: 8,
    usedSize: 128,
    payload: Buffer.alloc(2, 0xff),
    range: { offset: 96, length: 4 },
    detail: "ends before the observed FFS file end at 0x82",
  },
])(
  "reports FV extension coverage and retains the FFS file for $name",
  async ({
    entrySize,
    usedSize,
    payload = Buffer.from([0x31]),
    range,
    detail,
  }) => {
    const file = buildFfsFile({ guid: GUID_RAW, typeCode: 1, payload });
    const { buffer } = buildFv({ files: [file], extendedHeader: "standalone" });
    buffer.writeUInt16LE(entrySize, 92);
    buffer.writeUInt32LE(usedSize, 96);
    const root = await createTestTempDirectory("rea-uefi-fv-extension-");
    const path = join(root, "image.fd");
    await writeFile(path, buffer);
    const provider = new UefiAnalysisProvider();
    try {
      const inspected = expectOk(await provider.execute(inspectRequest(path)))
        .value.result as UefiInspectResult;
      expect(inspected.coverage).toBe(range === null ? "complete" : "partial");
      expect(inspected.firmware_volumes[0]?.ffs_files).toMatchObject([
        { offset: 104, length: 24 + payload.length },
      ]);
      const result = expectOk(
        await provider.execute(
          extractRequest(path, join(root, "volume"), {
            target: { kind: "volume", offset: 0 },
          }),
        ),
      ).value.result as UefiExtractResult;
      expect(result.files).toMatchObject([{ sha256: sha256(payload) }]);
      expect(result.extraction_gaps).toMatchObject(
        range === null
          ? []
          : [
              {
                kind: "unparsed-region",
                logical_path: "flash/FV@0x0",
                range,
                detail: expect.stringContaining(detail ?? ""),
              },
            ],
      );
      const selected = expectOk(
        await provider.execute(
          extractRequest(path, join(root, "file"), {
            target: { kind: "ffs-file", offset: 104 },
          }),
        ),
      ).value.result as UefiExtractResult;
      expect(selected.coverage).toBe("complete");
      expect(selected.files).toMatchObject([{ sha256: sha256(payload) }]);
    } finally {
      await provider.close();
    }
  },
);

it("retains decode provenance when extracting an empty decoded firmware volume", async () => {
  const decoded = buildFv({ files: [], blockSize: 128 }).buffer;
  const file = buildFfsFile({
    guid: GUID_DRIVER,
    typeCode: 7,
    payload: amdZlibSection(decoded),
  });
  const root = await createTestTempDirectory("rea-uefi-empty-decoded-volume-");
  const path = join(root, "image.fd");
  await writeFile(path, buildFv({ files: [file] }).buffer);
  const provider = new UefiAnalysisProvider();
  try {
    const inspected = expectOk(await provider.execute(inspectRequest(path)))
      .value.result as UefiInspectResult;
    const source = inspected.firmware_volumes[1]?.source_stream;
    expect(source).toEqual(expect.any(String));
    const result = expectOk(
      await provider.execute(
        extractRequest(path, join(root, "out"), {
          target: { kind: "volume", offset: 0, source_stream: source },
        }),
      ),
    ).value.result as UefiExtractResult;
    expect(result.coverage).toBe("complete");
    expect(result.files).toEqual([]);
    expect(result.derivations).toMatchObject([
      {
        child_stream: source,
        child_path: null,
        parent_stream: null,
        parent_file_range: {
          offset: 96 + 24 + AMD_ZLIB_HEADER_LENGTH,
          length: deflateSync(decoded).length,
        },
      },
    ]);
  } finally {
    await provider.close();
  }
});

it.each([
  { name: "empty", body: Buffer.alloc(0), gap: { offset: 96, length: 4 } },
  {
    name: "erased",
    body: Buffer.alloc(128, 0xff),
    gap: { offset: 100, length: 128 },
  },
])(
  "reports missing required FV framing for an $name FV-image section",
  async ({ body, gap }) => {
    const section = buildSection(0x17, body);
    const file = buildFfsFile({
      guid: GUID_DRIVER,
      typeCode: 7,
      payload: Buffer.concat([section, buildSection(0x19, RAW_BODY)]),
    });
    const root = await createTestTempDirectory("rea-uefi-missing-fv-image-");
    const path = join(root, "image.fd");
    await writeFile(path, buildFv({ files: [file] }).buffer);
    const provider = new UefiAnalysisProvider();
    try {
      const inspected = expectOk(await provider.execute(inspectRequest(path)))
        .value.result as UefiInspectResult;
      expect(inspected.coverage).toBe("partial");
      expect(inspected.firmware_volumes).toHaveLength(1);
      const result = expectOk(
        await provider.execute(
          extractRequest(path, join(root, "out"), {
            target: { kind: "section", offset: 96 },
          }),
        ),
      ).value.result as UefiExtractResult;
      expect(result.coverage).toBe("partial");
      expect(result.extraction_gaps).toMatchObject([
        { kind: "unparsed-region", range: gap },
      ]);
      const peer = expectOk(
        await provider.execute(
          extractRequest(path, join(root, "peer"), {
            target: { kind: "section", offset: 96 + section.length },
          }),
        ),
      ).value.result as UefiExtractResult;
      expect(peer.coverage).toBe("complete");
      expect(peer.files).toMatchObject([{ sha256: sha256(RAW_BODY) }]);
    } finally {
      await provider.close();
    }
  },
);

it.skipIf(!lzmaWorkerAvailable)(
  "retains valid LZMA output while recording the exact unread carrier suffix",
  async () => {
    const decoded = buildSection(0x19, RAW_BODY);
    const compressed = Buffer.from(lzmaPurescript.compressFile(decoded));
    const unread = Buffer.from("ordinary unread fixture bytes");
    const image = buildFv({
      files: [
        buildFfsFile({
          guid: GUID_DRIVER,
          typeCode: 7,
          payload: buildLzmaGuidedSection(Buffer.concat([compressed, unread])),
        }),
      ],
    });
    const directory = await createTestTempDirectory("rea-uefi-lzma-suffix-");
    const path = join(directory, "image.fd");
    await writeFile(path, image.buffer);
    const provider = new UefiAnalysisProvider(distUefiLzmaWorker);
    try {
      const inspected = expectOk(await provider.execute(inspectRequest(path)))
        .value.result as UefiInspectResult;
      expect(inspected.coverage).toBe("partial");
      const result = expectOk(
        await provider.execute(
          extractRequest(path, join(directory, "out"), {
            include_compressed: false,
          }),
        ),
      ).value.result as UefiExtractResult;
      const carrierStart = 120; // 72-byte FV, 24-byte FFS and 24-byte guided headers.
      expect(result.coverage).toBe("partial");
      expect(result.derivations).toMatchObject([
        {
          parent_file_range: {
            offset: carrierStart,
            length: compressed.length,
          },
        },
      ]);
      expect(result.extraction_gaps).toMatchObject([
        {
          kind: "unparsed-region",
          source_stream: null,
          range: {
            offset: carrierStart + compressed.length,
            length: unread.length,
          },
          detail: expect.stringContaining("did not examine"),
        },
      ]);
      expect(result.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "raw-section",
            sha256: sha256(RAW_BODY),
          }),
        ]),
      );
    } finally {
      await provider.close();
    }
  },
);

it("skips a large file in FFS2 while preserving the next file for inspection and extraction", async () => {
  const large = buildFfsFile({
    guid: GUID_DRIVER,
    typeCode: 1,
    payload: Buffer.alloc(0x100_0000 - 24),
  });
  const compact = buildFfsFile({
    guid: GUID_RAW,
    typeCode: 1,
    payload: RAW_BODY,
  });
  const { buffer } = buildFv({ files: [large, compact] });
  const root = await createTestTempDirectory("rea-uefi-ffs2-large-");
  const path = join(root, "image.fd");
  await writeFile(path, buffer);
  const provider = new UefiAnalysisProvider();
  try {
    const inspected = expectOk(await provider.execute(inspectRequest(path)))
      .value.result as UefiInspectResult;
    expect(inspected.coverage).toBe("partial");
    expect(inspected.firmware_volumes[0]?.ffs_files).toMatchObject([
      { guid: GUID_RAW, offset: 72 + large.length },
    ]);
    const extracted = expectOk(
      await provider.execute(extractRequest(path, join(root, "out"))),
    ).value.result as UefiExtractResult;
    expect(extracted.files).toMatchObject([{ sha256: sha256(RAW_BODY) }]);
    expect(extracted.extraction_gaps).toMatchObject([
      { kind: "unparsed-region", range: { offset: 72, length: large.length } },
    ]);
  } finally {
    await provider.close();
  }
});

it.each([
  ["FFS2", FFS2_FILE_SYSTEM_GUID, 0x100_0000n],
  ["FFS3", FFS3_FILE_SYSTEM_GUID, 0xffff_ffff_ffff_ffffn],
] as const)(
  "preserves a later %s file across interrupted headers and unpublished data",
  async (_, fileSystemGuid, size) => {
    const incomplete = Buffer.alloc(32, 0xff);
    incomplete[19] = 1;
    incomplete.fill(0, 20, 23);
    incomplete[23] = 0x1f; // Header invalid. Its ExtendedSize cannot establish an extent.
    incomplete.writeBigUInt64LE(size, 24);
    const pending = buildFfsFile({
      guid: GUID_DRIVER,
      typeCode: 1,
      payload: Buffer.from([0x31]),
    });
    pending[23] = 0x3c; // Header valid, data validity not set.
    const intact = buildFfsFile({
      guid: GUID_RAW,
      typeCode: 1,
      payload: RAW_BODY,
    });
    const { buffer } = buildFv({
      files: [incomplete, pending, intact],
      fileSystemGuid,
    });
    const root = await createTestTempDirectory("rea-uefi-interrupted-ffs-");
    const path = join(root, "image.fd");
    await writeFile(path, buffer);
    const provider = new UefiAnalysisProvider();
    try {
      const inspected = expectOk(await provider.execute(inspectRequest(path)))
        .value.result as UefiInspectResult;
      expect(inspected.coverage).toBe("partial");
      expect(
        inspected.firmware_volumes[0]?.ffs_files.map(({ offset, checksum }) => [
          offset,
          checksum,
        ]),
      ).toEqual([
        [104, "unchecked"],
        [136, "unchecked"],
      ]);
      const extracted = expectOk(
        await provider.execute(extractRequest(path, join(root, "out"))),
      ).value.result as UefiExtractResult;
      expect(extracted.files).toMatchObject([{ sha256: sha256(RAW_BODY) }]);
      expect(extracted.extraction_gaps).toMatchObject([
        { kind: "unparsed-region", range: { offset: 72, length: 32 } },
        { kind: "unparsed-region", range: { offset: 128, length: 1 } },
      ]);
    } finally {
      await provider.close();
    }
  },
);

it.each([
  {
    name: "unterminated",
    payload: Buffer.from("Title", "utf16le"),
    kind: "unparsed-region",
    offset: 96,
    length: 14,
  },
  {
    name: "beyond the display limit",
    payload: Buffer.from("A".repeat(512) + "\0", "utf16le"),
    kind: "size-truncated",
    offset: 1124,
    length: 2,
  },
])(
  "keeps a UI name unknown when it is $name while retaining its stored bytes",
  async ({ payload, kind, offset, length }) => {
    const file = buildFfsFile({
      guid: GUID_DRIVER,
      typeCode: 7,
      payload: buildSection(0x15, payload),
    });
    const root = await createTestTempDirectory("rea-uefi-ui-name-");
    const path = join(root, "image.fd");
    await writeFile(path, buildFv({ files: [file] }).buffer);
    const provider = new UefiAnalysisProvider();
    try {
      const inspected = expectOk(await provider.execute(inspectRequest(path)))
        .value.result as UefiInspectResult;
      expect(inspected.coverage).toBe("partial");
      expect(inspected.firmware_volumes[0]?.ffs_files[0]?.ui_string).toBeNull();
      const extracted = expectOk(
        await provider.execute(extractRequest(path, join(root, "out"))),
      ).value.result as UefiExtractResult;
      expect(extracted.extraction_gaps).toMatchObject([
        { kind, range: { offset, length } },
      ]);
      expect(extracted.files).toMatchObject([{ sha256: sha256(payload) }]);
    } finally {
      await provider.close();
    }
  },
);
