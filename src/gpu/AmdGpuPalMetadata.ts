import type {
  GpuAmdPalMetadata,
  GpuLocation,
} from "../domain/gpu/gpuCodeObjects.js";
import { BinaryFormatFailure } from "../domain/binaryContainer.js";
import { amdCount, amdRecord, amdString } from "./AmdGpuMetadata.js";
import { rejectGpu } from "./GpuSource.js";

type Pipeline = GpuAmdPalMetadata["pipelines"][number];
type HardwareStage = Pipeline["hardware_stages"][number];
export interface AmdPalNotes {
  readonly metadata: GpuAmdPalMetadata;
  readonly limitations: readonly string[];
}

/**
 * Accumulates the PAL-ABI pipeline declarations of one code object's
 * `amdpal.pipelines` notes (LLVM AMDGPUUsage, AMDPAL code object metadata).
 * Container shapes the schema requires are malformed when violated; a scalar
 * of an unexpected type stays unknown with a limitation.
 */
export class AmdPalMetadataReader {
  readonly #pipelines: Pipeline[] = [];
  readonly #limitations: string[] = [];
  readonly #versions = new Set<string>();
  #version: GpuAmdPalMetadata["version"] = null;
  #notes = 0;

  /** Read one note map; earlier notes and pipelines survive a later failure. */
  read(metadata: Record<string, unknown>, location: GpuLocation): void {
    this.#notes++;
    const note = `AMDGPU PAL note ${String(this.#notes - 1)}`;
    this.#readVersion(metadata, note);
    if (!Object.hasOwn(metadata, "amdpal.pipelines"))
      throw new BinaryFormatFailure(
        "unsupported",
        `${note} declares no amdpal.pipelines metadata`,
      );
    const pipelines = metadata["amdpal.pipelines"];
    if (!Array.isArray(pipelines))
      rejectGpu(`${note} amdpal.pipelines is not an array`);
    for (const [index, value] of (pipelines as unknown[]).entries()) {
      const row = amdRecord(value);
      if (row === null)
        rejectGpu(`${note} pipeline ${String(index)} is not a map`);
      const where = `${note} pipeline ${String(index)}`;
      this.#pipelines.push({
        index,
        name: this.#string(row!, ".name", where),
        type: this.#string(row!, ".type", where),
        api: this.#string(row!, ".api", where),
        shaders: this.#entries(row!, ".shaders", where).map(
          ([stage, shader]) => ({
            stage,
            hardware_mapping: this.#hardwareMapping(
              shader,
              `${where} shader ${stage}`,
            ),
          }),
        ),
        hardware_stages: this.#entries(row!, ".hardware_stages", where).map(
          ([stage, fields]) =>
            this.#hardwareStage(stage, fields, `${where} stage ${stage}`),
        ),
        location,
      });
    }
  }

  /** Declared facts, with limitations for values that remain unknown. */
  result(): AmdPalNotes | null {
    return this.#notes === 0
      ? null
      : {
          metadata: {
            version: this.#versions.size === 1 ? this.#version : null,
            pipelines: this.#pipelines,
          },
          limitations: this.#limitations,
        };
  }

  #readVersion(metadata: Record<string, unknown>, note: string): void {
    const value = metadata["amdpal.version"];
    const parts =
      Array.isArray(value) && value.length === 2 ? value.map(amdCount) : null;
    const declared = Object.hasOwn(metadata, "amdpal.version");
    const valid = parts !== null && !parts.includes(null);
    // LLVM omits amdpal.version unless the module sets one, so absence
    // leaves the version null without a limitation.
    if (declared && !valid)
      this.#limit(
        `${note} amdpal.version is not two unsigned integers; the version is unknown`,
      );
    if (declared && valid)
      this.#version ??= { major: parts[0]!, minor: parts[1]! };
    this.#versions.add(
      !declared ? "absent" : valid ? parts.join(".") : "invalid",
    );
    if (this.#versions.size > 1)
      this.#limit(
        "AMDGPU PAL notes declare different metadata versions; the version is unknown",
      );
  }

  #limit(message: string): void {
    if (!this.#limitations.includes(message)) this.#limitations.push(message);
  }

  #string(row: Record<string, unknown>, key: string, where: string) {
    if (!Object.hasOwn(row, key)) return null;
    const value = amdString(row[key]);
    if (value === null)
      this.#limit(`${where} ${key} is not a string; it remains unknown`);
    return value;
  }

  #count(row: Record<string, unknown>, key: string, where: string) {
    if (!Object.hasOwn(row, key)) return null;
    const value = amdCount(row[key]);
    if (value === null)
      this.#limit(
        `${where} ${key} is not an unsigned integer; it remains unknown`,
      );
    return value;
  }

  /** Stage maps are keyed by declared stage names, kept as written. */
  #entries(
    row: Record<string, unknown>,
    key: string,
    where: string,
  ): [string, Record<string, unknown>][] {
    if (!Object.hasOwn(row, key)) return [];
    const map = amdRecord(row[key]);
    if (map === null) rejectGpu(`${where} ${key} is not a map`);
    return Object.entries(map!).map(([stage, value]) => {
      const fields = amdRecord(value);
      if (fields === null) rejectGpu(`${where} ${key} ${stage} is not a map`);
      return [stage, fields!];
    });
  }

  #hardwareMapping(
    shader: Record<string, unknown>,
    where: string,
  ): string[] | null {
    if (!Object.hasOwn(shader, ".hardware_mapping")) return null;
    const value = shader[".hardware_mapping"];
    const stages = Array.isArray(value) ? value.map(amdString) : null;
    if (stages === null || stages.includes(null))
      rejectGpu(`${where} .hardware_mapping is not an array of strings`);
    return stages as string[];
  }

  #hardwareStage(
    stage: string,
    fields: Record<string, unknown>,
    where: string,
  ): HardwareStage {
    return {
      stage,
      entry_point: this.#string(fields, ".entry_point", where),
      entry_point_symbol: this.#string(fields, ".entry_point_symbol", where),
      sgpr_count: this.#count(fields, ".sgpr_count", where),
      vgpr_count: this.#count(fields, ".vgpr_count", where),
      agpr_count: this.#count(fields, ".agpr_count", where),
      wavefront_size: this.#count(fields, ".wavefront_size", where),
      lds_size: this.#count(fields, ".lds_size", where),
      scratch_memory_size: this.#count(fields, ".scratch_memory_size", where),
    };
  }
}
