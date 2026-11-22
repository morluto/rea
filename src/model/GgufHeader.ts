import { BinaryReader } from "../domain/binaryContainer.js";
import { strictUtf8Decoder } from "../domain/strictUtf8.js";
import { isUtf8 } from "node:buffer";
import { setImmediate } from "node:timers/promises";
import type { JsonValue } from "../domain/jsonValue.js";
import type {
  ModelMetadata,
  ModelTensor,
  ModelArtifactPartialTensor,
} from "../domain/model/modelArtifact.js";
import { ModelHeaderReader } from "./ModelHeaderReader.js";
import { unsupportedInput } from "../domain/parseFailure.js";
import {
  MODEL_ARRAY_PREVIEW,
  MODEL_METADATA_NESTING,
  MODEL_FORMAT,
  modelCapacityFailure,
  ModelReportBudget,
  rejectModel,
} from "./ModelFormat.js";
import { ggmlType } from "./ModelTensorTypes.js";

const NAMES = [
  "UINT8",
  "INT8",
  "UINT16",
  "INT16",
  "UINT32",
  "INT32",
  "FLOAT32",
  "BOOL",
  "STRING",
  "ARRAY",
  "UINT64",
  "INT64",
  "FLOAT64",
] as const;
const STRING_LENGTH_BYTES = 8;
const WIDTHS = [1, 1, 2, 2, 4, 4, 4, 1, STRING_LENGTH_BYTES, 12, 8, 8, 8];
const MIN_METADATA_ROW_BYTES = STRING_LENGTH_BYTES + 4 + 1;
const TENSOR_STORAGE_FIELDS_BYTES = 4 + 8;
const MIN_TENSOR_DESCRIPTOR_BYTES =
  STRING_LENGTH_BYTES + 4 + TENSOR_STORAGE_FIELDS_BYTES;

export interface GgufProgress {
  onHeader(info: {
    version: number;
    byte_order: "little" | "big";
    declared_metadata_count: number;
    declared_tensor_count: number;
  }): void;
  onMetadata(row: ModelMetadata): void;
  onAlignment(alignment: number): void;
  onMetadataComplete(): void;
  onTensorsStarted(): void;
  onTensorDeclaration(row: ModelArtifactPartialTensor): void;
  onLimitation(message: string): void;
}

/** Explicit-endian GGUF v2/v3 metadata and tensor-directory parser. */
export class GgufHeader {
  #little = true;
  readonly #budget = new ModelReportBudget();
  constructor(readonly reader: ModelHeaderReader) {}

  // take() returns exactly `width` bytes, so field reads at 0 stay in range.
  async #field(width: number): Promise<BinaryReader> {
    return new BinaryReader(
      await this.reader.take(width),
      this.#little,
      "gguf",
    );
  }

  async #unsigned(width: 4 | 8): Promise<bigint> {
    return (await this.#field(width)).word(0, width === 4 ? 32 : 64);
  }

  async #text(
    retain: boolean,
    requiredAfter: number,
    maximum?: number,
  ): Promise<string> {
    const rawLength = await this.#unsigned(STRING_LENGTH_BYTES);
    if (maximum !== undefined && rawLength > BigInt(maximum))
      rejectModel("GGUF name exceeds its format byte limit");
    this.reader.guarantee(rawLength + BigInt(requiredAfter));
    const length = Number(rawLength);
    if (retain) this.#budget.charge(6 * length + 2);
    // Omitted preview entries still need validation, but not decoded strings.
    // Keep the streaming decoder for values spanning multiple read chunks.
    if (!retain && length <= 65536) {
      if (!isUtf8(await this.reader.take(length)))
        rejectModel("GGUF string is not valid UTF-8");
      return "";
    }
    const decoder = strictUtf8Decoder("preserve");
    let result = "";
    try {
      for (let left = length; left > 0;) {
        const n = Math.min(left, 65536);
        const text = decoder.decode(await this.reader.take(n), {
          stream: true,
        });
        if (retain) result += text;
        left -= n;
      }
      const tail = decoder.decode();
      if (retain) result += tail;
    } catch (cause) {
      if (cause instanceof TypeError)
        rejectModel("GGUF string is not valid UTF-8");
      throw cause;
    }
    return result;
  }

  async #value(
    type: number,
    retain: boolean,
    requiredAfter: number,
    enclosingFrames = 0,
  ): Promise<{
    value: JsonValue;
    element_type: string | null;
    element_count: number | null;
    complete: boolean;
  }> {
    const width = WIDTHS[type];
    if (width === undefined)
      rejectModel(`Unknown GGUF metadata type ${String(type)}`);
    this.reader.guarantee(width + requiredAfter);
    if (type === 8)
      return {
        value: await this.#text(retain, requiredAfter),
        element_type: null,
        element_count: null,
        complete: true,
      };
    if (type === 9) {
      // The frame is the counted unit and an empty innermost array still
      // occupies one, so charge it on entry instead of on a child visit.
      const frames = enclosingFrames + 1;
      if (frames > MODEL_METADATA_NESTING)
        throw modelCapacityFailure(
          "metadata-nesting",
          `GGUF metadata nesting exceeds ${String(MODEL_METADATA_NESTING)} array frames`,
        );
      const element = Number(await this.#unsigned(4));
      const rawCount = await this.#unsigned(8);
      const minimum = WIDTHS[element];
      if (minimum === undefined)
        rejectModel(`Unknown GGUF array element type ${String(element)}`);
      this.reader.guarantee(rawCount * BigInt(minimum) + BigInt(requiredAfter));
      const count = Number(rawCount);
      const preview: JsonValue[] = [];
      if (retain)
        this.#budget.charge(128 + Math.min(count, MODEL_ARRAY_PREVIEW) * 64);
      let complete = count <= MODEL_ARRAY_PREVIEW;
      for (let index = 0; index < count; index++) {
        if (index % 4096 === 4095) await setImmediate();
        if (
          element !== 8 &&
          element !== 9 &&
          (!retain || index >= MODEL_ARRAY_PREVIEW)
        ) {
          let left = (count - index) * minimum;
          while (left > 0) {
            const size = Math.min(left, 65536);
            const bytes = await this.reader.take(size);
            if (element === 7 && bytes.some((byte) => byte !== 0 && byte !== 1))
              rejectModel("GGUF boolean must be 0 or 1");
            left -= size;
          }
          break;
        }
        const keep = retain && index < MODEL_ARRAY_PREVIEW;
        const value = await this.#value(
          element,
          keep,
          (count - index - 1) * minimum + requiredAfter,
          frames,
        );
        if (keep)
          preview.push(
            element === 9
              ? {
                  type: "ARRAY",
                  element_type: value.element_type,
                  element_count: value.element_count,
                  preview: value.value,
                  preview_complete: value.complete,
                }
              : value.value,
          );
        complete &&= value.complete;
      }
      return {
        value: preview,
        element_type: NAMES[element] ?? null,
        element_count: count,
        complete,
      };
    }
    const b = await this.#field(width);
    let value: JsonValue;
    switch (type) {
      case 0:
        value = b.u8(0);
        break;
      case 1:
        value = b.i8(0);
        break;
      case 2:
        value = b.u16(0);
        break;
      case 3:
        value = b.i16(0);
        break;
      case 4:
        value = b.u32(0);
        break;
      case 5:
        value = b.i32(0);
        break;
      case 6:
        value = b.f32(0);
        break;
      case 7: {
        const byte = b.u8(0);
        if (byte !== 0 && byte !== 1)
          rejectModel("GGUF boolean must be 0 or 1");
        value = byte === 1;
        break;
      }
      case 10:
        value = b.word(0, 64).toString();
        break;
      case 11:
        value = b.i64(0).toString();
        break;
      case 12:
        value = b.f64(0);
        break;
      default:
        return rejectModel("Unsupported GGUF scalar");
    }
    if (Object.is(value, -0)) value = "-0";
    if (typeof value === "number" && !Number.isFinite(value))
      value = Number.isNaN(value)
        ? "NaN"
        : value > 0
          ? "+Infinity"
          : "-Infinity";
    return {
      value: retain ? value : null,
      element_type: null,
      element_count: null,
      complete: true,
    };
  }

  async read(progress?: GgufProgress): Promise<{
    version: number;
    byte_order: "little" | "big";
    alignment: number;
    tensor_data_offset: number;
    metadata: ModelMetadata[];
    tensors: ModelTensor[];
    limitations: string[];
  }> {
    const versionBytes = await this.reader.take(4);
    const littleVersion = new BinaryReader(versionBytes, true, "gguf").u32(0);
    const bigVersion = new BinaryReader(versionBytes, false, "gguf").u32(0);
    let version: number;
    if (littleVersion === 2 || littleVersion === 3) {
      this.#little = true;
      version = littleVersion;
    } else if (bigVersion === 2 || bigVersion === 3) {
      this.#little = false;
      version = bigVersion;
    } else {
      throw unsupportedInput(
        MODEL_FORMAT,
        `GGUF version bytes ${versionBytes.toString("hex")} are unsupported (little-endian ${String(littleVersion)}, big-endian ${String(bigVersion)}; byte order unknown); supported versions are 2 and 3`,
      );
    }
    if (!this.#little && version !== 3)
      rejectModel("Big-endian GGUF requires version 3");
    const rawTensorCount = await this.#unsigned(8);
    const rawMetadataCount = await this.#unsigned(8);
    const minimumDirectoryBytes =
      rawTensorCount * BigInt(MIN_TENSOR_DESCRIPTOR_BYTES) +
      rawMetadataCount * BigInt(MIN_METADATA_ROW_BYTES);
    this.reader.requireFileExtent(this.reader.position, minimumDirectoryBytes);
    const tensorCount = Number(rawTensorCount);
    const metadataCount = Number(rawMetadataCount);
    progress?.onHeader({
      version,
      byte_order: this.#little ? "little" : "big",
      declared_metadata_count: metadataCount,
      declared_tensor_count: tensorCount,
    });
    this.reader.guarantee(minimumDirectoryBytes);
    this.#budget.charge((tensorCount + metadataCount) * 512);
    const metadata: ModelMetadata[] = [];
    const keys = new Set<string>();
    let alignment = 32;
    let remainingDirectoryBytes = Number(minimumDirectoryBytes);
    for (let index = 0; index < metadataCount; index++) {
      this.reader.guarantee(remainingDirectoryBytes);
      remainingDirectoryBytes -= MIN_METADATA_ROW_BYTES;
      const start = this.reader.position;
      const key = await this.#text(
        true,
        remainingDirectoryBytes + MIN_METADATA_ROW_BYTES - STRING_LENGTH_BYTES,
        65535,
      );
      // Numeric hierarchy components occur in standardized base_model.{id} keys.
      if (
        !/^[a-z0-9]+(?:[_-][a-z0-9]+)*(?:\.[a-z0-9]+(?:[_-][a-z0-9]+)*)*$/u.test(
          key,
        )
      )
        rejectModel(
          "GGUF metadata keys require lowercase ASCII hierarchy components",
        );
      if (keys.has(key)) rejectModel(`Duplicate GGUF metadata key ${key}`);
      keys.add(key);
      const type = Number(await this.#unsigned(4));
      const parsed = await this.#value(type, true, remainingDirectoryBytes);
      const row = {
        index,
        key,
        type: NAMES[type] ?? String(type),
        value: parsed.value,
        element_type: parsed.element_type,
        element_count: parsed.element_count,
        preview_complete: parsed.complete,
        source_offset: start,
        source_length: this.reader.position - start,
        json_pointer: null,
      } satisfies ModelMetadata;
      if (key === "general.alignment") {
        if (
          type !== 4 ||
          typeof parsed.value !== "number" ||
          parsed.value === 0 ||
          parsed.value % 8 !== 0
        )
          rejectModel(
            "GGUF general.alignment must be a positive UINT32 multiple of eight",
          );
        alignment = parsed.value;
        progress?.onAlignment(alignment);
      }
      metadata.push(row);
      progress?.onMetadata(row);
    }
    if (!keys.has("general.alignment")) progress?.onAlignment(alignment);
    progress?.onMetadataComplete();
    progress?.onTensorsStarted();
    const tensors: ModelArtifactPartialTensor[] = [];
    const names = new Set<string>();
    const limitations = new Set<string>();
    const note = (message: string): void => {
      if (limitations.has(message)) return;
      limitations.add(message);
      progress?.onLimitation(message);
    };
    for (let index = 0; index < tensorCount; index++) {
      this.reader.guarantee(remainingDirectoryBytes);
      remainingDirectoryBytes -= MIN_TENSOR_DESCRIPTOR_BYTES;
      const start = this.reader.position;
      const name = await this.#text(
        true,
        remainingDirectoryBytes +
          MIN_TENSOR_DESCRIPTOR_BYTES -
          STRING_LENGTH_BYTES,
        64,
      );
      if (names.has(name)) rejectModel(`Duplicate GGUF tensor name ${name}`);
      names.add(name);
      const dimensions = Number(await this.#unsigned(4));
      if (dimensions > 4)
        rejectModel("GGUF tensor dimension count must be at most 4");
      this.reader.guarantee(
        dimensions * 8 + TENSOR_STORAGE_FIELDS_BYTES + remainingDirectoryBytes,
      );
      const shape: string[] = [];
      let parameters = 1n;
      for (let d = 0; d < dimensions; d++) {
        const value = await this.#unsigned(8);
        shape.push(value.toString());
        parameters *= value;
      }
      const id = Number(await this.#unsigned(4));
      const rawOffset = await this.#unsigned(8);
      this.reader.requireFileExtent(0, rawOffset);
      const offset = Number(rawOffset);
      if (offset % alignment !== 0)
        rejectModel(`GGUF tensor ${name} offset is not aligned`);
      const type = ggmlType(id);
      let length: number | null = null;
      if (type !== undefined) {
        const [, rowElementMultiple, blockBytes, limitation] = type;
        if (BigInt(shape[0] ?? "1") % BigInt(rowElementMultiple) !== 0n)
          rejectModel(
            `GGUF tensor ${name} first dimension must be a multiple of ${String(rowElementMultiple)} elements`,
          );
        if (
          limitation !== undefined &&
          (parameters !== 0n || limitation.kind === "type-identity")
        )
          note(limitation.reason);
        if (parameters === 0n) length = 0;
        else if (blockBytes !== null) {
          const bytes =
            (parameters / BigInt(rowElementMultiple)) * BigInt(blockBytes);
          if (bytes > BigInt(this.reader.size))
            rejectModel(
              `GGUF tensor ${name} declared byte length exceeds the file`,
            );
          length = Number(bytes);
        }
      } else
        note(
          `Unknown tensor type UNKNOWN_${String(id)} prevents storage-size validation.`,
        );
      const tensor = {
        index,
        name,
        type: type?.[0] ?? `UNKNOWN_${String(id)}`,
        type_id: id,
        shape,
        data_offset: offset,
        file_offset: null,
        byte_length: length,
        parameter_count: parameters.toString(),
        byte_length_state: length === null ? "unknown" : "derived",
        storage_validation: "not-established",
        source_offset: start,
        source_length: this.reader.position - start,
        json_pointer: null,
      } satisfies ModelArtifactPartialTensor;
      tensors.push(tensor);
      progress?.onTensorDeclaration(tensor);
    }
    const directoryEnd = this.reader.position;
    const alignedDataOffset = Math.ceil(directoryEnd / alignment) * alignment;
    const tensor_data_offset =
      tensorCount === 0 && this.reader.size === directoryEnd
        ? directoryEnd
        : alignedDataOffset;
    if (tensor_data_offset > this.reader.size)
      rejectModel("GGUF tensor data section begins outside the file");
    for (const tensor of tensors) {
      const offset = BigInt(tensor_data_offset) + BigInt(tensor.data_offset);
      if (
        offset > BigInt(this.reader.size) ||
        offset + BigInt(tensor.byte_length ?? 0) > BigInt(this.reader.size)
      )
        rejectModel(`GGUF tensor ${tensor.name} range is outside the file`);
      tensor.file_offset = Number(offset);
    }
    const completeTensors: ModelTensor[] = tensors.map((tensor) => ({
      ...tensor,
      file_offset: tensor.file_offset!,
      storage_validation:
        tensor.byte_length === null ? "unknown" : "consistent",
    }));
    const intervals = completeTensors
      .filter((row) => row.byte_length !== null)
      .sort((a, b) => a.file_offset - b.file_offset);
    let end = tensor_data_offset;
    for (const row of intervals) {
      if (row.file_offset < end && row.byte_length !== 0)
        rejectModel(`Overlapping tensor byte ranges at ${row.name}`);
      end = Math.max(end, row.file_offset + (row.byte_length ?? 0));
    }
    return {
      version,
      byte_order: this.#little ? "little" : "big",
      alignment,
      tensor_data_offset,
      metadata,
      tensors: completeTensors,
      limitations: [...limitations],
    };
  }
}
