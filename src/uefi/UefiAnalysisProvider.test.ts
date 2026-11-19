import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import { SafeOutputTree } from "../resources/SafeOutputTree.js";
import { SafeOutputTreeCreationFailure } from "../resources/SafeOutputTreeCreationFailure.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
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
} from "../../tests/fixtures/uefiImage.js";
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
    // The only gap is the pad file; the LZMA stream decoded, so coverage holds.
    expect(result.extraction_gaps.every((gap) => gap.kind === "pad-file")).toBe(
      true,
    );
    expect(result.coverage).toBe("complete");
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

const amdZlibSection = (content: Buffer): Buffer => {
  const stream = deflateSync(content);
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
  "retains the worker root across a failed descriptor retry and releases its child before root removal",
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
    const closeHandle = OwnedFileHandle.prototype.close;
    const closeRoot = PrivateRuntimeRoot.prototype.close;
    let root: PrivateRuntimeRoot | undefined;
    let outputHandle: OwnedFileHandle | undefined;
    let denyDescriptor = true;
    let denyRoot = true;
    const creating = vi
      .spyOn(PrivateRuntimeRoot, "create")
      .mockImplementation(async (options) => {
        const created = await create(options);
        if (options?.prefix === "rea-uefi-lzma-") root = created;
        return created;
      });
    const closingHandle = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        const outputPath =
          root === undefined ? undefined : join(root.path, "output.bin");
        if (outputPath !== undefined && this.handle.fd >= 0) {
          const output = await stat(outputPath).catch(() => undefined);
          const fd = await this.handle.stat();
          if (
            output !== undefined &&
            fd.dev === output.dev &&
            fd.ino === output.ino
          ) {
            outputHandle = this;
            if (denyDescriptor) throw new Error("worker output close denied");
          }
        }
        return closeHandle.call(this);
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
      if (result.ok || root === undefined || outputHandle === undefined) {
        throw new Error("worker output descriptor failure was not exercised");
      }
      expect(result.error.cleanupResources).toEqual(
        expect.arrayContaining([root.path, join(root.path, "output.bin")]),
      );
      await expect(provider.close()).rejects.toThrow(
        /cleanup remains incomplete/i,
      );
      expect(closingRoot.mock.contexts).not.toContain(root);
      expect(existsSync(root.path)).toBe(true);

      denyDescriptor = false;
      await expect(provider.close()).rejects.toThrow(
        /cleanup remains incomplete/i,
      );
      expect(outputHandle.handle.fd).toBe(-1);
      expect(result.error.cleanupResources).toEqual([root.path]);
      expect(existsSync(root.path)).toBe(true);

      denyRoot = false;
      await expect(provider.close()).resolves.toBeUndefined();
      expect(existsSync(root.path)).toBe(false);
      expect(result.error.cleanupIncomplete).toBe(false);
    } finally {
      creating.mockRestore();
      closingHandle.mockRestore();
      closingRoot.mockRestore();
      await provider.close();
    }
  },
  45_000,
);

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
