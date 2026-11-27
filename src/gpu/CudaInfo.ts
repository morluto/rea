import {
  BinaryReader,
  BinaryResourceFailure,
} from "../domain/binaryContainer.js";
import {
  DEFAULT_GPU_OBJECT_BYTES,
  DEFAULT_GPU_PARSER_VISITS,
  DEFAULT_GPU_REPORT_BYTES,
  GPU_OBJECT_BYTES_LIMIT,
  GPU_PARSER_VISITS_LIMIT,
  type GpuCodeObjectsBudgets,
} from "../domain/gpu/gpuCodeObjectsBudgets.js";
import { rejectGpu } from "./GpuSource.js";
import { Budget } from "../domain/budget.js";
import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";
import type { JsonValue } from "../domain/jsonValue.js";

/** Shared by every metadata record, symbol and temporary index in one CUDA ELF. */
export class CudaMetadataBudget {
  readonly #maxVisits: number;
  readonly #maxReadBytes: number;
  readonly #maxIndexBytes: number;
  readonly #visits: Budget;
  readonly #readBytes: Budget;
  readonly #indexBytes: Budget;
  constructor(
    budgets?: Pick<
      GpuCodeObjectsBudgets,
      "maxParserVisits" | "maxObjectBytes" | "maxReportBytes"
    >,
  ) {
    this.#maxVisits = budgets?.maxParserVisits ?? DEFAULT_GPU_PARSER_VISITS;
    this.#maxReadBytes = budgets?.maxObjectBytes ?? DEFAULT_GPU_OBJECT_BYTES;
    this.#maxIndexBytes = budgets?.maxReportBytes ?? DEFAULT_GPU_REPORT_BYTES;
    this.#visits = new Budget(this.#maxVisits);
    this.#readBytes = new Budget(this.#maxReadBytes);
    this.#indexBytes = new Budget(this.#maxIndexBytes);
  }
  visit(): void {
    this.#visits.charge(
      1,
      () =>
        new BinaryResourceFailure(
          "structure",
          this.#maxVisits,
          `CUDA metadata exceeds ${String(this.#maxVisits)} aggregate record/symbol visits`,
          GPU_PARSER_VISITS_LIMIT,
          "entries",
        ),
    );
  }
  read(size: number): void {
    this.#readBytes.charge(
      size,
      () =>
        new BinaryResourceFailure(
          "structure",
          this.#maxReadBytes,
          `CUDA metadata exceeds ${String(this.#maxReadBytes)}-byte aggregate section reads`,
          GPU_OBJECT_BYTES_LIMIT,
          "bytes",
        ),
    );
  }
  retain(value: JsonValue): void {
    this.#indexBytes.charge(
      jsonValueByteLength(value, this.#maxIndexBytes) + 2,
      () =>
        new BinaryResourceFailure(
          "structure",
          this.#maxIndexBytes,
          `CUDA metadata exceeds the ${String(this.#maxIndexBytes)}-byte temporary index budget`,
          "gpu-retained-report-bytes",
          "bytes",
        ),
    );
  }
}
interface CudaInfoRecord {
  readonly format: number;
  readonly attribute: number;
  readonly value: number;
  readonly offset: number;
  readonly length: number;
  readonly data: Buffer;
}
/** CUDA nv.info is a numeric record format, not a string-keyed metadata map. */
export function* readCudaInfo(
  bytes: Buffer,
  little: boolean,
  budget = new CudaMetadataBudget(),
): Generator<CudaInfoRecord> {
  const reader = new BinaryReader(bytes, little, "cuda-nv-info");
  for (let offset = 0; offset < bytes.length;) {
    budget.visit();
    const head = reader.range(offset, 4, "CUDA nv.info record");
    const format = head[0]!,
      attribute = head[1]!,
      value = reader.u16(offset + 2);
    if (format < 1 || format > 4)
      rejectGpu("Unknown CUDA nv.info record format");
    const length = format === 4 ? value : 0;
    yield {
      format,
      attribute,
      value,
      offset,
      length: 4 + length,
      data: reader.range(offset + 4, length, "CUDA nv.info value"),
    };
    offset += 4 + length;
  }
}

/** Kernel argument interpretation owns duplicate and range semantics at the numeric-record boundary. */
export const readCudaParameters = (
  bytes: Buffer,
  little: boolean,
  budget = new CudaMetadataBudget(),
) => {
  const parameters: import("../domain/gpu/gpuCodeObjects.js").GpuKernel["parameters"] =
    [];
  const byteDeclarations = new Set<number>();
  const limitations: string[] = [];
  const reader = new BinaryReader(bytes, little, "cuda-nv-info");
  let complete = true;
  for (const record of readCudaInfo(bytes, little, budget)) {
    if (record.format === 3 && record.attribute === 0x19)
      byteDeclarations.add(record.value);
    if (
      record.format !== 4 ||
      (record.attribute !== 0x17 && record.attribute !== 0x45)
    )
      continue;
    if (record.data.length !== 12) {
      complete = false;
      continue;
    }
    const base = record.offset + 4;
    if (reader.u32(base) !== 0) complete = false;
    const parameter = {
      ordinal: reader.u16(base + 4),
      name: null,
      offset: reader.u16(base + 6),
      size:
        record.attribute === 0x45
          ? reader.u32(base + 8)
          : reader.u32(base + 8) >>> 18,
      type: null,
      hidden: null,
    };
    budget.retain(parameter);
    parameters.push(parameter);
  }
  parameters.sort((a, b) => a.ordinal - b.ordinal);
  if (parameters.some((row, index) => row.ordinal !== index)) complete = false;
  const parameter_bytes =
    byteDeclarations.size === 1 ? [...byteDeclarations][0]! : null;
  if (byteDeclarations.size > 1)
    limitations.push(
      `Conflicting CUDA argument-area byte declarations: ${[...byteDeclarations].join(", ")}; parameter_bytes remains unknown`,
    );
  if (
    parameter_bytes !== null &&
    parameters.some(
      (row) =>
        row.offset! > parameter_bytes ||
        row.size! > parameter_bytes - row.offset!,
    )
  )
    limitations.push(
      "CUDA parameter ranges disagree with the declared argument-area length; declarations do not establish a valid ABI layout",
    );
  if (!complete)
    limitations.push(
      "CUDA parameter records have unsupported indices/sizes, duplicate ordinals or gaps; parameter count is unknown",
    );
  return {
    parameter_count:
      complete && (parameters.length > 0 || parameter_bytes === 0)
        ? parameters.length
        : null,
    parameter_bytes,
    parameters,
    limitations,
  };
};
