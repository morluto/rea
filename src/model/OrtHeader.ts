import { setImmediate } from "node:timers/promises";
import { assertArtifactReadActive } from "../artifacts/ArtifactFileOperation.js";
import type {
  ModelDimension,
  ModelGraphValue,
  ModelMetadata,
  ModelOperator,
  ModelTensor,
} from "../domain/model/modelArtifact.js";
import { ModelHeaderReader } from "./ModelHeaderReader.js";
import {
  ModelFormatFailure,
  ModelReportBudget,
  rejectModel,
} from "./ModelFormat.js";
import {
  OrtFlatBuffer,
  type OrtTable,
  type OrtVector,
} from "./OrtFlatBuffer.js";

// ONNX Runtime's published ort.fbs TensorDataType values. Unknown IDs remain
// observed IDs; they do not acquire a storage width from the payload length.
const TYPES: Readonly<Record<number, readonly [string, number | null]>> = {
  0: ["UNDEFINED", null],
  1: ["FLOAT", 4],
  2: ["UINT8", 1],
  3: ["INT8", 1],
  4: ["UINT16", 2],
  5: ["INT16", 2],
  6: ["INT32", 4],
  7: ["INT64", 8],
  8: ["STRING", null],
  9: ["BOOL", 1],
  10: ["FLOAT16", 2],
  11: ["DOUBLE", 8],
  12: ["UINT32", 4],
  13: ["UINT64", 8],
  14: ["COMPLEX64", 8],
  15: ["COMPLEX128", 16],
  16: ["BFLOAT16", 2],
  17: ["FLOAT8E4M3FN", 1],
  18: ["FLOAT8E4M3FNUZ", 1],
  19: ["FLOAT8E5M2", 1],
  20: ["FLOAT8E5M2FNUZ", 1],
};

type Facet = "inputs" | "outputs" | "operators" | "initializers";
export interface OrtHeaderResult {
  version: null;
  ort_version: string | null;
  file_identifier: "ORTM";
  byte_order: "little";
  alignment: null;
  tensor_data_offset: null;
  metadata: ModelMetadata[];
  tensors: ModelTensor[];
  inputs: ModelGraphValue[];
  outputs: ModelGraphValue[];
  operators: ModelOperator[];
  ort_coverage: Record<Facet | "header", "complete" | "partial">;
  limitations: string[];
}

/** Published ORT schema field slots, including the TypeInfo union discriminator.
 * https://github.com/microsoft/onnxruntime/blob/main/onnxruntime/core/flatbuffers/schema/ort.fbs
 * No runtime, external files, graph execution, or tensor values are consulted.
 */
class OrtDeclarations {
  readonly result: OrtHeaderResult = {
    version: null,
    ort_version: null,
    file_identifier: "ORTM",
    byte_order: "little",
    alignment: null,
    tensor_data_offset: null,
    metadata: [],
    tensors: [],
    inputs: [],
    outputs: [],
    operators: [],
    ort_coverage: {
      header: "complete",
      inputs: "complete",
      outputs: "complete",
      operators: "complete",
      initializers: "complete",
    },
    limitations: [
      "ORT tables and tensor payloads are interleaved. Header inspection reads the complete FlatBuffer under the 100,000,000-byte allowance; payload values are not interpreted.",
      "ORT inventories describe the top-level graph. Runtime optimization records, kernel resolvers, attributes, and nested graphs are not interpreted; runtime compatibility is not established.",
      "ORT model metadata properties are not interpreted.",
    ],
  };
  readonly #values = new Map<string, ModelGraphValue | null>();
  readonly #tensorNames = new Set<string>();
  readonly #completed = new Set<Facet>();
  #steps = 0;
  constructor(
    readonly fb: OrtFlatBuffer,
    readonly signal?: AbortSignal,
    readonly onProgress?: (progress: OrtHeaderResult) => void,
  ) {}

  #progress(): void {
    if (this.onProgress === undefined) return;
    const coverage = { ...this.result.ort_coverage };
    for (const facet of [
      "inputs",
      "outputs",
      "operators",
      "initializers",
    ] as const)
      if (!this.#completed.has(facet)) {
        coverage[facet] = "partial";
        coverage.header = "partial";
      }
    this.onProgress({ ...this.result, ort_coverage: coverage });
  }

  #partial(facet: Facet | "header", reason: string): void {
    this.result.ort_coverage[facet] = "partial";
    this.result.ort_coverage.header = "partial";
    if (!this.result.limitations.includes(reason)) {
      this.fb.budget.charge(6 * reason.length + 64);
      this.result.limitations.push(reason);
    }
  }

  #attempt<T>(facet: Facet | "header", read: () => T): T | undefined {
    try {
      return read();
    } catch (cause) {
      if (!(cause instanceof ModelFormatFailure) || cause.kind !== "format")
        throw cause;
      this.#partial(
        facet,
        `ORT ${facet}: ${cause.message}. Readable sibling declarations are retained.`,
      );
      return undefined;
    }
  }

  async #checkpoint(): Promise<void> {
    this.#progress();
    if (++this.#steps % 256 === 0) await setImmediate();
    assertArtifactReadActive(this.signal);
  }

  async #each(
    table: OrtTable,
    slot: number,
    facet: Facet | "header",
    read: (entry: number, index: number) => void,
  ): Promise<void> {
    const vector = this.#attempt(facet, () => this.fb.vector(table, slot, 4));
    if (!vector) return;
    // Charge before retaining any per-entry representation or indexing names.
    this.fb.budget.charge(vector.count * 192);
    for (let index = 0; index < vector.count; index++) {
      await this.#checkpoint();
      this.#attempt(facet, () => read(vector.offset + index * 4, index));
    }
  }

  #typeId(table: OrtTable, slot: number): number {
    const id = this.fb.int(table, slot);
    if (id < 0) rejectModel("ORT tensor element type ID is negative");
    return id;
  }

  #shape(table: OrtTable): ModelDimension[] | null {
    const shape = this.fb.child(table, 1);
    if (shape === null) return null;
    const vector = this.fb.vector(shape, 0, 4);
    if (vector === null) return [];
    this.fb.budget.charge(vector.count * 128);
    const result: ModelDimension[] = [];
    for (let index = 0; index < vector.count; index++) {
      const dimension = this.fb.table(
        this.fb.reference(vector.offset + index * 4),
      );
      const value = this.fb.child(dimension, 0);
      if (value === null) {
        result.push({ kind: "unknown" });
        continue;
      }
      switch (this.fb.byte(value, 0)) {
        case 1: {
          const number = this.fb.long(value, 1);
          result.push(
            number < 0n
              ? { kind: "unknown" }
              : { kind: "value", value: String(number) },
          );
          break;
        }
        case 2: {
          const symbol = this.fb.text(value, 2);
          result.push(
            symbol === null ? { kind: "unknown" } : { kind: "symbol", symbol },
          );
          break;
        }
        default:
          result.push({ kind: "unknown" });
      }
    }
    return result;
  }

  #value(table: OrtTable): ModelGraphValue {
    const name = this.fb.text(table, 0);
    if (name === null) rejectModel("ORT ValueInfo is missing its name");
    const result: ModelGraphValue = {
      index: 0,
      name,
      type: null,
      type_id: null,
      type_kind: "unknown",
      shape: null,
      ...this.fb.source(table),
    };
    const type = this.fb.child(table, 2);
    if (type === null) return result;
    // A FlatBuffers union occupies two slots: discriminator 1, table 2.
    const kind = this.fb.byte(type, 1);
    if (kind !== 1) {
      result.type_kind =
        kind === 2 ? "sequence" : kind === 3 ? "map" : "unknown";
      return result;
    }
    const tensor = this.fb.child(type, 2);
    if (tensor === null) return result;
    result.type_kind = "tensor";
    result.type_id = this.#typeId(tensor, 0);
    result.type = TYPES[result.type_id]?.[0] ?? null;
    result.shape = this.#shape(tensor);
    return result;
  }

  async #io(
    graph: OrtTable,
    slot: number,
    facet: "inputs" | "outputs",
  ): Promise<void> {
    const names = new Set<string>();
    await this.#each(graph, slot, facet, (entry) => {
      const name = this.fb.textAt(entry);
      if (names.has(name))
        rejectModel("ORT graph contains a duplicate I/O name");
      names.add(name);
      const value = this.#values.get(name);
      const row: ModelGraphValue =
        value === undefined || value === null
          ? {
              index: this.result[facet].length,
              name,
              type: null,
              type_id: null,
              type_kind: "unknown",
              shape: null,
              source_offset: entry,
              source_length: 4,
              json_pointer: null,
            }
          : { ...value, index: this.result[facet].length };
      this.result[facet].push(row);
      if (value === undefined || value === null)
        this.#partial(
          facet,
          `ORT ${facet} include names without uniquely readable ValueInfo declarations; their types and shapes remain unknown.`,
        );
    });
    this.#completed.add(facet);
  }

  #tensor(table: OrtTable): ModelTensor {
    const name = this.fb.text(table, 0);
    if (name === null) rejectModel("ORT initializer is missing its name");
    if (this.#tensorNames.has(name))
      rejectModel("ORT initializer names are not unique");
    const dimensions = this.fb.vector(table, 2, 8);
    const shape: string[] = [];
    let parameters = 1n;
    this.fb.budget.charge((dimensions?.count ?? 0) * 64 + 512);
    for (let index = 0; index < (dimensions?.count ?? 0); index++) {
      const dimension = this.fb.bytes.readBigInt64LE(
        dimensions!.offset + index * 8,
      );
      if (dimension < 0n) rejectModel("ORT initializer dimension is negative");
      parameters *= dimension;
      if (parameters > 0xffffffffffffffffn)
        rejectModel("ORT initializer parameter count exceeds uint64");
      shape.push(String(dimension));
    }
    const typeId = this.#typeId(table, 3);
    const type = TYPES[typeId];
    const raw = this.fb.vector(table, 4, 1);
    const strings = this.fb.vector(table, 5, 4);
    const external = this.fb.long(table, 6, -1n);
    if (external < -1n)
      rejectModel("ORT external initializer offset is invalid");
    const local = external === -1n && typeId !== 8 && raw !== null;
    const width = type?.[1];
    const consistent =
      local &&
      width != null &&
      BigInt(raw.count) === parameters * BigInt(width);
    if (local && width != null && !consistent)
      this.#partial(
        "initializers",
        "ORT initializer byte lengths disagree with their element types and shapes; observed extents are retained without storage validation.",
      );
    if (external >= 0n)
      this.#partial(
        "initializers",
        "ORT external initializer offsets are retained as declarations; external files, byte lengths, and contents are not read.",
      );
    if (typeId === 8 || strings !== null)
      this.#partial(
        "initializers",
        "ORT string initializer payloads are not interpreted and have no single reported contiguous byte extent.",
      );
    if (type === undefined)
      this.#partial(
        "initializers",
        "Unknown ORT initializer element type IDs retain their numeric identity and declared local byte extents; storage sizes are unverified.",
      );
    this.#tensorNames.add(name);
    return {
      index: this.result.tensors.length,
      name,
      type: type?.[0] ?? `UNKNOWN_${String(typeId)}`,
      type_id: typeId,
      shape,
      data_offset: null,
      file_offset: local ? raw.offset : null,
      byte_length: local ? raw.count : null,
      parameter_count: String(parameters),
      byte_length_state: local ? "declared" : "unknown",
      storage_validation: consistent ? "consistent" : "unknown",
      external_data_offset: external >= 0n ? String(external) : null,
      ...this.fb.source(table),
    };
  }

  async read(): Promise<OrtHeaderResult> {
    const session = this.fb.table(this.fb.reference(0));
    this.result.ort_version =
      this.#attempt("header", () => this.fb.text(session, 0)) ?? null;
    if (this.result.ort_version === null)
      this.#partial(
        "header",
        "ORT format version is unreadable or absent; compatibility with any ORT runtime is unknown.",
      );
    this.#progress();
    const model = this.#attempt("header", () => this.fb.child(session, 1));
    const graph =
      model && this.#attempt("header", () => this.fb.child(model, 7));
    if (!graph) {
      for (const facet of [
        "inputs",
        "outputs",
        "operators",
        "initializers",
      ] as const)
        this.#partial(
          facet,
          "ORT model graph is unreadable or absent; graph inventories are unknown.",
        );
      this.#progress();
      return this.result;
    }
    await this.#each(graph, 1, "header", (entry) => {
      const value = this.#value(this.fb.table(this.fb.reference(entry)));
      if (this.#values.has(value.name)) {
        this.#values.set(value.name, null);
        this.#partial(
          "header",
          "ORT contains duplicate ValueInfo names; matching I/O types and shapes remain unknown.",
        );
      } else this.#values.set(value.name, value);
    });
    await this.#io(graph, 5, "inputs");
    await this.#io(graph, 6, "outputs");
    await this.#each(graph, 2, "operators", (entry) => {
      const node = this.fb.table(this.fb.reference(entry));
      const since = this.fb.intOrNull(node, 3);
      const operator: ModelOperator = {
        index: this.result.operators.length,
        name: this.fb.text(node, 0),
        op_type: this.fb.text(node, 5),
        domain: this.fb.text(node, 2),
        since_version: since !== null && since >= 0 ? since : null,
        ...this.fb.source(node),
      };
      this.result.operators.push(operator);
      if (
        operator.op_type === null ||
        operator.domain === null ||
        operator.since_version === null
      )
        this.#partial(
          "operators",
          "ORT operator declarations contain unresolved names, domains, or versions; missing values remain unknown.",
        );
    });
    this.#completed.add("operators");
    await this.#each(graph, 0, "initializers", (entry) => {
      this.result.tensors.push(
        this.#tensor(this.fb.table(this.fb.reference(entry))),
      );
    });
    const sparse: OrtVector | null | undefined = this.#attempt(
      "initializers",
      () => this.fb.vector(graph, 7, 4),
    );
    if (sparse && sparse.count > 0)
      this.#partial(
        "initializers",
        "ORT sparse initializers are present but are not included in the dense initializer inventory.",
      );
    this.#completed.add("initializers");
    this.#progress();
    return this.result;
  }
}

/** `first` is the already-read eight-byte ORTM prefix. */
export const readOrtHeader = async (
  reader: ModelHeaderReader,
  first: Buffer,
  onProgress?: (progress: OrtHeaderResult) => void,
): Promise<OrtHeaderResult> => {
  if (
    reader.position !== 8 ||
    first.length !== 8 ||
    !first.subarray(4, 8).equals(Buffer.from("ORTM"))
  )
    rejectModel("Invalid ORTM FlatBuffers prefix");
  reader.guarantee(reader.size - 8);
  const bytes = Buffer.concat([first, await reader.take(reader.size - 8)]);
  const parser = new OrtDeclarations(
    new OrtFlatBuffer(bytes, new ModelReportBudget()),
    reader.signal,
    onProgress,
  );
  return parser.read();
};
