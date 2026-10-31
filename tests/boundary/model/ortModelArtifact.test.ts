import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { ModelArtifactProvider } from "../../../src/model/ModelArtifactProvider.js";
import { ModelHeaderReader } from "../../../src/model/ModelHeaderReader.js";
import { OrtFlatBuffer } from "../../../src/model/OrtFlatBuffer.js";
import {
  ModelFormatFailure,
  ModelReportBudget,
} from "../../../src/model/ModelFormat.js";
import {
  readOrtHeader,
  type OrtHeaderResult,
} from "../../../src/model/OrtHeader.js";
import { modelArtifactSchema } from "../../../src/domain/model/modelArtifact.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { ortFixture } from "../../fixtures/model/ort.js";

const inspect = async (bytes: Buffer, hash: "header" | "full" = "header") => {
  const root = await createTestTempDirectory("rea-ort-model-");
  const path = join(root, "model.data");
  await writeFile(path, bytes);
  const provider = new ModelArtifactProvider();
  onTestFinished(() => provider.close());
  return provider.inspect({ path, hash });
};

it.each(["header", "full"] as const)(
  "inspects ORTM declarations by content with %s hashing",
  async (hash) => {
    const { bytes } = ortFixture();
    const result = await inspect(bytes, hash);
    if (!result.ok) throw result.error;
    const report = modelArtifactSchema.parse(result.value);
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(report).toMatchObject({
      format: "ort",
      file_identifier: "ORTM",
      ort_version: "6",
      version: null,
      artifact: {
        header_sha256: digest,
        header_length: bytes.length,
        bytes_read: bytes.length,
        sha256: hash === "full" ? digest : null,
        read_scope: "full-file",
      },
      inputs: [
        {
          name: "images",
          type: "FLOAT",
          type_id: 1,
          type_kind: "tensor",
          shape: [
            { kind: "symbol", symbol: "batch" },
            { kind: "value", value: "3" },
            { kind: "symbol", symbol: "height" },
            { kind: "symbol", symbol: "width" },
          ],
        },
      ],
      operators: [
        { op_type: "ConvInteger", domain: "", since_version: 10 },
        { op_type: "QuickGelu", domain: "com.microsoft", since_version: 1 },
      ],
      tensors: [
        {
          name: "weight",
          type: "FLOAT",
          shape: ["2", "2"],
          byte_length: 16,
          parameter_count: "4",
          storage_validation: "consistent",
        },
      ],
      coverage: {
        header: "complete",
        inputs: "complete",
        outputs: "complete",
        operators: "complete",
        initializers: "complete",
      },
    });
    const tensor = report.tensors[0]!;
    expect(tensor.file_offset).not.toBeNull();
    expect(
      bytes
        .subarray(
          tensor.file_offset!,
          tensor.file_offset! + tensor.byte_length!,
        )
        .toString("hex"),
    ).toBe("a5".repeat(16));
    expect(report.limitations.join(" ")).toContain("interleaved");
  },
);

it.each([
  { inputShape: [], expected: [] },
  { inputShape: null, expected: null },
  {
    inputShape: [0n, null, "width"],
    expected: [
      { kind: "value", value: "0" },
      { kind: "unknown" },
      { kind: "symbol", symbol: "width" },
    ],
  },
])(
  "preserves scalar, unknown rank, and omitted zero dimensions: $inputShape",
  async ({ inputShape, expected }) => {
    const result = await inspect(ortFixture({ inputShape }).bytes);
    if (!result.ok) throw result.error;
    expect(result.value.inputs?.[0]?.shape).toEqual(expected);
  },
);

it.each([
  {
    inputType: 999,
    inputKind: 1,
    expected: { type: null, type_id: 999, type_kind: "tensor" },
  },
  {
    inputType: 1,
    inputKind: 2,
    expected: { type: null, type_id: null, type_kind: "sequence", shape: null },
  },
  {
    inputType: 1,
    inputKind: 3,
    expected: { type: null, type_id: null, type_kind: "map", shape: null },
  },
  {
    inputType: 1,
    inputKind: 99,
    expected: { type: null, type_id: null, type_kind: "unknown", shape: null },
  },
])(
  "retains unresolved type information: union=$inputKind dtype=$inputType",
  async ({ inputType, inputKind, expected }) => {
    const result = await inspect(ortFixture({ inputType, inputKind }).bytes);
    if (!result.ok) throw result.error;
    expect(result.value.inputs?.[0]).toMatchObject(expected);
  },
);

it("retains I/O names when their ValueInfo is missing", async () => {
  const result = await inspect(ortFixture({ missingInput: true }).bytes);
  if (!result.ok) throw result.error;
  expect(result.value.inputs).toMatchObject([
    { name: "images", type: null, shape: null },
  ]);
  expect(result.value.coverage).toMatchObject({
    header: "partial",
    inputs: "partial",
    outputs: "complete",
  });
});

it("keeps duplicate ValueInfo identities unresolved when one declaration is malformed", async () => {
  const { bytes, fields } = ortFixture({ duplicateInput: true });
  const field = fields.get("duplicateInputValue.2")!;
  bytes.writeUInt32LE(0xffffffff, field);
  const result = await inspect(bytes);
  if (!result.ok) throw result.error;
  expect(result.value.inputs).toMatchObject([
    {
      name: "images",
      type: null,
      type_id: null,
      type_kind: "unknown",
      shape: null,
    },
  ]);
  expect(result.value.coverage).toMatchObject({
    header: "partial",
    inputs: "partial",
  });
  expect(result.value.limitations.join(" ")).toContain(
    "duplicate ValueInfo names",
  );
});

it("does not charge invalid shared strings to the retained report budget", () => {
  const length = 65_000;
  const bytes = Buffer.alloc(length + 9);
  bytes.writeUInt32LE(4, 0);
  bytes.writeUInt32LE(length, 4);
  bytes[8] = 0xff;
  const flatBuffer = new OrtFlatBuffer(bytes, new ModelReportBudget());
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      flatBuffer.textAt(0);
      throw new Error("Invalid UTF-8 string accepted");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ModelFormatFailure);
      expect(cause).toMatchObject({ kind: "format" });
    }
  }
});

it("keeps an omitted operator version unknown", async () => {
  const result = await inspect(
    ortFixture({ missingOperatorVersion: true }).bytes,
  );
  if (!result.ok) throw result.error;
  expect(result.value.operators?.[0]).toMatchObject({
    op_type: "ConvInteger",
    since_version: null,
  });
  expect(result.value.coverage).toMatchObject({
    header: "partial",
    operators: "partial",
  });
});

it.each([
  {
    options: { externalOffset: 9007199254740993n },
    expected: {
      external_data_offset: "9007199254740993",
      file_offset: null,
      byte_length: null,
    },
  },
  {
    options: { stringTensor: true },
    expected: { type: "STRING", file_offset: null, byte_length: null },
  },
  {
    options: { tensorType: 999 },
    expected: {
      type: "UNKNOWN_999",
      type_id: 999,
      byte_length: 16,
      storage_validation: "unknown",
    },
  },
  {
    options: { tensorBytes: 12 },
    expected: { byte_length: 12, storage_validation: "unknown" },
  },
])(
  "preserves unknown initializer storage without opening external files: $options",
  async ({ options, expected }) => {
    const result = await inspect(ortFixture(options).bytes);
    if (!result.ok) throw result.error;
    expect(result.value.tensors[0]).toMatchObject(expected);
    expect(result.value.coverage.initializers).toBe("complete");
    expect(result.value.coverage.storage_sizes).toBe("partial");
    expect(result.value.coverage.tensor_ranges).toBe(
      "externalOffset" in options || "stringTensor" in options
        ? "partial"
        : "complete",
    );
  },
);

it("reports sparse initializer coverage explicitly", async () => {
  const result = await inspect(ortFixture({ sparseInitializer: true }).bytes);
  if (!result.ok) throw result.error;
  expect(result.value.tensors).toHaveLength(1);
  expect(result.value.coverage.header).toBe("complete");
  expect(result.value.coverage.initializers).toBe("partial");
  expect(result.value.limitations.join(" ")).toContain("sparse initializers");
});

it.each(["pointer", "utf8", "field-width"] as const)(
  "retains readable operators when a sibling has invalid %s",
  async (corruption) => {
    const { bytes, fields } = ortFixture();
    const field = fields.get("node0.5")!;
    if (corruption === "pointer") bytes.writeUInt32LE(0xffffffff, field);
    else if (corruption === "utf8")
      bytes[field + bytes.readUInt32LE(field) + 4] = 0xff;
    else {
      const since = fields.get("node0.3")!;
      const table = since - (8 + 3 * 8);
      const vtable = table - bytes.readInt32LE(table);
      bytes.writeUInt16LE(1, vtable + 4 + 3 * 2);
    }
    const result = await inspect(bytes);
    if (!result.ok) throw result.error;
    expect(result.value.operators).toMatchObject([
      { index: 0, op_type: "QuickGelu" },
    ]);
    expect(result.value.coverage).toMatchObject({
      header: "partial",
      operators: "partial",
      inputs: "complete",
    });
  },
);

it("rejects an invalid root without native out-of-bounds errors", async () => {
  const { bytes } = ortFixture();
  bytes.writeUInt32LE(0xffffffff, 0);
  const result = await inspect(bytes);
  if (result.ok) throw new Error("Invalid root accepted");
  expect(result.error).toMatchObject({
    _tag: "BinaryTargetError",
    constraint: "file_format_rejected",
  });
});

it("bounds an impossible vector count and preserves other facets", async () => {
  const { bytes, fields } = ortFixture();
  const field = fields.get("graph.2")!;
  bytes.writeUInt32LE(0xffffffff, field + bytes.readUInt32LE(field));
  const result = await inspect(bytes);
  if (!result.ok) throw result.error;
  expect(result.value.operators).toEqual([]);
  expect(result.value.inputs).toHaveLength(1);
  expect(result.value.coverage.operators).toBe("partial");
});

it("preserves unknown ORT format version strings without runtime compatibility claims", async () => {
  const result = await inspect(
    ortFixture({ version: "future-format-version" }).bytes,
  );
  if (!result.ok) throw result.error;
  expect(result.value.ort_version).toBe("future-format-version");
  expect(result.value.limitations.join(" ")).toContain(
    "compatibility is not established",
  );
});

it("publishes only proven declarations before a cancelled collection walk", async () => {
  const { bytes } = ortFixture();
  const root = await createTestTempDirectory("rea-ort-cancel-");
  const path = join(root, "model.ort");
  await writeFile(path, bytes);
  const handle = await open(path, "r");
  const controller = new AbortController();
  let progress: OrtHeaderResult | undefined;
  try {
    const reader = new ModelHeaderReader(
      handle,
      bytes.length,
      controller.signal,
    );
    const prefix = await reader.take(8);
    await expect(
      readOrtHeader(reader, prefix, (snapshot) => {
        progress = snapshot;
        if (snapshot.operators.length === 1)
          controller.abort(new Error("stop after first operator"));
      }),
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(progress).toMatchObject({
      ort_version: "6",
      inputs: [{ name: "images" }],
      outputs: [{ name: "result" }],
      operators: [{ op_type: "ConvInteger" }],
      tensors: [],
      declared_tensor_count: 1,
      ort_coverage: {
        header: "partial",
        inputs: "complete",
        outputs: "complete",
        operators: "partial",
        initializers: "partial",
      },
    });
  } finally {
    await handle.close();
  }
});
