import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { z } from "zod";

import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { BinaryTargetError } from "../domain/configurationErrors.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { FileOffsetPartialObservation } from "../domain/native/fileOffsetPartialObservation.js";
import {
  readFatSliceDeclarations,
  type FatSliceDeclaration,
  validateFatSlice,
} from "../domain/apple/machoContainer.js";
import { err, ok, type Result } from "../domain/result.js";

const OPERATION = "address_to_file_offset";
const MAX_FAT_ARCHITECTURES = 128;
const PREFIX_BYTES = 8 + MAX_FAT_ARCHITECTURES * 32;
const observationSchema = z.strictObject({
  address: z.string().regex(/^0x[0-9a-f]+$/u),
  provider_file_offset: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  provider_source_path: z.string().nullable(),
  provider_image_header_hex: z
    .string()
    .regex(/^[a-f0-9]{24}$/u)
    .nullable(),
});
type Observation = z.infer<typeof observationSchema>;

/** Bind native image-relative offsets to coordinates in the admitted source bytes. */
export async function mapHopperFileOffset(
  target: BinaryTarget,
  value: JsonValue,
  signal?: AbortSignal,
): Promise<Result<JsonValue, AnalysisError>> {
  const parsed = observationSchema.safeParse(value);
  if (!parsed.success)
    return err(
      new AnalysisOutputError(
        OPERATION,
        "Hopper's native file mapping observation is malformed",
      ),
    );
  const observation = parsed.data;
  const partial = (reason: string): FileOffsetPartialObservation => ({
    operation: OPERATION,
    ...observation,
    original_file_offset: { available: false, reason },
  });
  const unavailable = (reason: string) =>
    err(
      new AnalysisCapabilityUnavailableError("hopper", OPERATION, reason, {
        partialObservation: partial(reason),
      }),
    );
  if (target.kind !== "executable")
    return unavailable(
      "The selected database digest does not identify its original executable bytes. Open that executable to verify original-file coordinates; read_bytes still exposes the database's native bytes.",
    );
  if (signal?.aborted)
    return err(
      new AnalysisCancelledError(OPERATION, {
        partialObservation: partial("Source verification was cancelled"),
      }),
    );
  try {
    const captured = await snapshotFromPath(target.path, signal);
    if (!captured.ok)
      return err(
        new AnalysisArtifactChangedError(
          OPERATION,
          target.path,
          captured.error,
          {
            partialObservation: partial(captured.error),
          },
        ),
      );
    const snapshot = captured.value;
    if (signal?.aborted)
      return err(
        new AnalysisCancelledError(OPERATION, {
          partialObservation: partial("Source verification was cancelled"),
        }),
      );
    if (snapshot.sha256 !== target.sha256) {
      const reason = `Source ${target.path} differs from the admitted artifact: expected SHA-256 ${target.sha256}, observed ${snapshot.sha256}. Reopen the changed source for a new analysis identity.`;
      return err(
        new AnalysisArtifactChangedError(OPERATION, target.path, reason, {
          partialObservation: partial(reason),
        }),
      );
    }
    const mapped = originalOffset(snapshot, observation);
    if (!mapped.ok) return unavailable(mapped.error);
    return ok({
      address: observation.address,
      file_offset: mapped.value + observation.provider_file_offset,
      provider_file_offset: observation.provider_file_offset,
      image_base_file_offset: mapped.value,
      source_path: target.path,
    });
  } catch (cause: unknown) {
    if (signal?.aborted)
      return err(
        new AnalysisCancelledError(OPERATION, {
          cause,
          partialObservation: partial("Source verification was cancelled"),
        }),
      );
    const reason = `Cannot verify original source bytes: ${cause instanceof Error ? cause.message : String(cause)}`;
    const code =
      typeof cause === "object" && cause !== null && "code" in cause
        ? cause.code
        : undefined;
    if (code === "EACCES" || code === "EPERM")
      return err(
        new AnalysisAccessDeniedError(OPERATION, target.path, code, {
          cause,
          partialObservation: partial(reason),
        }),
      );
    return err(
      new BinaryTargetError(target.path, reason, {
        cause,
        partialObservation: partial(reason),
      }),
    );
  }
}

async function snapshotFromPath(path: string, signal?: AbortSignal) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile())
      return err(
        `Source ${path} is no longer a regular file. Restore the admitted executable or reopen a regular source.`,
      );
    return ok(await readSourceSnapshot(file, signal));
  } finally {
    await file.close();
  }
}

interface FatLayout {
  readonly slices: readonly FatSliceDeclaration[];
  readonly tableEnd: number;
}

function fatLayout(prefix: Buffer): Result<FatLayout | null, string> {
  const magic = prefix.length < 4 ? 0 : prefix.readUInt32BE(0);
  if (![0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic))
    return ok(null);
  if (prefix.length < 8) return err("The original FAT header is truncated");
  const littleEndian = magic === 0xbebafeca || magic === 0xbfbafeca;
  const wide = magic === 0xcafebabf || magic === 0xbfbafeca;
  const count = littleEndian ? prefix.readUInt32LE(4) : prefix.readUInt32BE(4);
  if (count === 0 || count > MAX_FAT_ARCHITECTURES)
    return err("FAT architecture count is outside the supported 1..128 range");
  const tableEnd = 8 + count * (wide ? 32 : 20);
  const table = prefix.subarray(8, tableEnd);
  const parsed = readFatSliceDeclarations(table, { count, wide, littleEndian });
  if (parsed.status !== "parsed") return err(parsed.reason);
  if (wide) {
    for (const slice of parsed.slices)
      if (
        (littleEndian
          ? table.readUInt32LE(slice.index * 32 + 28)
          : table.readUInt32BE(slice.index * 32 + 28)) !== 0
      )
        return err(
          `FAT64 architecture ${slice.index} has a nonzero reserved field`,
        );
  }
  return ok({ slices: parsed.slices, tableEnd });
}

async function readSourceSnapshot(file: FileHandle, signal?: AbortSignal) {
  const prefix = Buffer.alloc(PREFIX_BYTES);
  const hash = createHash("sha256");
  let size = 0;
  let layout: Result<FatLayout | null, string> | undefined;
  const headers = new Map<number, Buffer>();
  const capture = (bytes: Buffer, position: number) => {
    if (layout?.ok !== true || layout.value === null) return;
    for (const slice of layout.value.slices) {
      const start = Math.max(position, slice.offset);
      const end = Math.min(position + bytes.length, slice.offset + 12);
      if (end <= start) continue;
      let header = headers.get(slice.index);
      if (header === undefined) {
        header = Buffer.alloc(12);
        headers.set(slice.index, header);
      }
      bytes.copy(
        header,
        start - slice.offset,
        start - position,
        end - position,
      );
    }
  };
  for await (const chunk of file.createReadStream({
    start: 0,
    autoClose: false,
    ...(signal === undefined ? {} : { signal }),
  })) {
    const bytes = Buffer.from(chunk);
    hash.update(bytes);
    if (size < prefix.length)
      bytes.copy(prefix, size, 0, Math.min(bytes.length, prefix.length - size));
    if (layout === undefined && size + bytes.length >= prefix.length) {
      layout = fatLayout(prefix);
      capture(prefix, 0);
    }
    capture(bytes, size);
    size += bytes.length;
  }
  if (layout === undefined) {
    layout = fatLayout(prefix.subarray(0, size));
    capture(prefix.subarray(0, size), 0);
  }
  return { layout, headers, size, sha256: hash.digest("hex") };
}

type SourceSnapshot = Awaited<ReturnType<typeof readSourceSnapshot>>;

function originalOffset(
  snapshot: SourceSnapshot,
  observation: Observation,
): Result<number, string> {
  const { layout, size, headers } = snapshot;
  if (!layout.ok) return layout;
  if (layout.value === null)
    return observation.provider_file_offset < size
      ? ok(0)
      : err("Provider mapping lies outside the admitted executable bytes");
  const header =
    observation.provider_image_header_hex === null
      ? null
      : Buffer.from(observation.provider_image_header_hex, "hex");
  const loadedMagic = header?.readUInt32BE(0);
  if (
    header === null ||
    loadedMagic === undefined ||
    ![0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(loadedMagic)
  )
    return err(
      "Hopper did not expose the loaded Mach-O header needed to identify its FAT slice",
    );
  const little = loadedMagic === 0xcefaedfe || loadedMagic === 0xcffaedfe;
  const cpu = little ? header.readUInt32LE(4) : header.readUInt32BE(4);
  const subtype = little ? header.readUInt32LE(8) : header.readUInt32BE(8);
  const matches = [];
  const ranges = [...layout.value.slices].sort((a, b) => a.offset - b.offset);
  for (let index = 1; index < ranges.length; index++) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.offset < previous.offset + previous.size
    )
      return err("Original FAT slices overlap");
  }
  for (const slice of layout.value.slices) {
    const reason = validateFatSlice(slice, size, layout.value.tableEnd);
    if (reason !== null) return err(reason);
    const embedded = headers.get(slice.index);
    if (slice.size < 12 || embedded === undefined)
      return err(
        `FAT architecture ${slice.index} has a truncated Mach-O header`,
      );
    const embeddedMagic = embedded.readUInt32BE(0);
    if (
      ![0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(embeddedMagic)
    )
      return err(
        `FAT architecture ${slice.index} does not contain a Mach-O image`,
      );
    const embeddedLittle =
      embeddedMagic === 0xcefaedfe || embeddedMagic === 0xcffaedfe;
    const identityError = validateFatSlice(slice, size, layout.value.tableEnd, {
      cpuType: embeddedLittle
        ? embedded.readUInt32LE(4)
        : embedded.readUInt32BE(4),
      cpuSubtype: embeddedLittle
        ? embedded.readUInt32LE(8)
        : embedded.readUInt32BE(8),
    });
    if (identityError !== null) return err(identityError);
    if (slice.cpuType === cpu && slice.cpuSubtype === subtype)
      matches.push(slice);
  }
  const selected = matches.length === 1 ? matches[0] : undefined;
  if (selected === undefined)
    return err(
      `Original FAT slice matching Hopper's loaded header is ${matches.length === 0 ? "missing" : "ambiguous"}`,
    );
  if (headers.get(selected.index)?.equals(header) !== true)
    return err(
      "Original FAT slice header disagrees with Hopper's loaded header",
    );
  if (observation.provider_file_offset >= selected.size)
    return err("Provider mapping lies outside the loaded FAT slice");
  if (!Number.isSafeInteger(selected.offset + observation.provider_file_offset))
    return err("Original file offset exceeds the exact JSON integer range");
  return ok(selected.offset);
}
