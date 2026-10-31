// Isolated byte observation; never registered by REA's production composition.
import { createHash } from "node:crypto";
import { z } from "zod";
import { AnalysisError } from "../../dist/domain/analysisErrorBase.js";
import {
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../dist/domain/analysisErrorCore.js";
import { err, ok } from "../../dist/domain/result.js";
import { observationError } from "./observation-error.mjs";
import { CleanupRetention } from "./cleanup-retention.mjs";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
} from "../../dist/artifacts/AnalysisCleanupLease.js";
import {
  RegularFileCancelled,
  RegularFileCleanupFailure,
  regularFileCancellation,
  withOwnedRegularFile,
} from "../../dist/filesystem/OwnedRegularFile.js";
import { assertRegularFileActive } from "../../dist/filesystem/RegularFile.js";

const OPERATION = "radare2_read_bytes_experiment";
const UINT64_MAX = 0xffffffffffffffffn;
// The prototype capture budget is 16 MiB. A quoted decimal byte can take six
// JSON characters, eight when retained inside escaped raw output, plus two
// characters in bytes_hex: reserve 16 bytes per requested byte. Section and
// fixed-envelope overhead still share the transport's independently enforced
// capture bound. This is an expansion bound, not a token or heap measurement.
export const MAX_NATIVE_READ_BYTES = (16 * 1024 * 1024) / 16;
export const byteInputSchema = z
  .strictObject({
    address: z.string().regex(/^0x[0-9a-f]{1,16}$/iu),
    length: z.number().int().min(1).max(MAX_NATIVE_READ_BYTES).default(256),
  })
  .refine(
    (input) => BigInt(input.address) + BigInt(input.length) <= UINT64_MAX + 1n,
    {
      path: ["length"],
      message: "Read exceeds the 64-bit address space",
    },
  );
const retainedHandles = new CleanupRetention();
const error = (reason, details) =>
  new AnalysisOutputError(OPERATION, reason, details);
const uint64 = (value) => {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
    throw error("Native integer is not lossless");
  if (
    !["number", "string", "bigint"].includes(typeof value) ||
    !/^(?:0x[0-9a-f]+|[0-9]+)$/iu.test(String(value))
  )
    throw error("Invalid native unsigned integer");
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX) throw error("Native integer exceeds 64 bits");
  return parsed;
};
const hex = (value) => `0x${value.toString(16)}`;
const success = (replies, index) => {
  const reply = replies[index];
  if (!reply || reply.command_outcome !== "no_error_reported")
    throw error(
      `Native byte query ${index + 1} failed; original status and output remain retained`,
    );
  return reply.res;
};

function decodeBytes(value, length) {
  if (!Array.isArray(value) || value.length > length)
    throw error(
      "Native byte response is not an array within the requested count",
    );
  const bytes = Buffer.alloc(value.length);
  for (let index = 0; index < value.length; index++) {
    if (!(index in value))
      throw error("Native byte array contains an unobserved slot");
    const byte = uint64(value[index]);
    if (byte > 255n)
      throw error("Native byte array contains a value outside uint8");
    bytes[index] = Number(byte);
  }
  return bytes;
}

// iSj owns these coordinates: size is initialized file-backed length; vsize
// alone cannot establish initialized bytes. Preserve the selected row verbatim.
function mapFileRange(sections, address, length) {
  if (!Array.isArray(sections))
    throw error("Native section inventory is not an array");
  const end = address + BigInt(length);
  const overlaps = [];
  let unknownRows = 0;
  for (const [index, source] of sections.entries()) {
    try {
      const size = uint64(source.size);
      if (size === 0n) continue;
      const vaddr = uint64(source.vaddr);
      const paddr = uint64(source.paddr);
      if (
        [size, vaddr, paddr].includes(UINT64_MAX) ||
        vaddr + size > UINT64_MAX + 1n
      )
        throw error("Section has an invalid initialized address range");
      if (address < vaddr + size && end > vaddr)
        overlaps.push({
          index,
          source,
          vaddr,
          paddr,
          size,
          contains: address >= vaddr && end <= vaddr + size,
        });
    } catch {
      // A row without usable bounds cannot prove it does not overlap this read.
      unknownRows++;
    }
  }
  if (unknownRows || overlaps.length !== 1 || !overlaps[0].contains)
    return {
      status: "unknown",
      reason: unknownRows
        ? "Malformed section coordinates leave overlap unknown"
        : "Requested bytes are not wholly inside one unique initialized section",
      intersecting_sections: overlaps.length,
      unknown_sections: unknownRows,
    };
  const selected = overlaps[0];
  const offset = selected.paddr + address - selected.vaddr;
  if (offset + BigInt(length) > UINT64_MAX + 1n)
    return {
      status: "unknown",
      reason: "Mapped file range exceeds native coordinates",
    };
  return {
    status: "unique-initialized-section",
    offset,
    section_index: selected.index,
    source: selected.source,
    file_offset: hex(offset),
    initialized_size: hex(selected.size),
  };
}

function stableMetadata(before, after) {
  return ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(
    (field) => before[field] === after[field],
  );
}

async function hashHandle(handle, length, signal) {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0n;
  while (position < length) {
    assertRegularFileActive(signal);
    const remaining = length - position;
    const wanted =
      remaining < BigInt(buffer.length) ? Number(remaining) : buffer.length;
    const { bytesRead } = await handle.read(buffer, 0, wanted, position);
    if (!bytesRead)
      throw error("File became short during independent digest verification");
    hash.update(buffer.subarray(0, bytesRead));
    position += BigInt(bytesRead);
  }
  assertRegularFileActive(signal);
  return hash.digest("hex");
}

async function fileBytes(handle, offset, length, signal) {
  const bytes = Buffer.alloc(length);
  let returned = 0;
  while (returned < length) {
    assertRegularFileActive(signal);
    const read = await handle.read(
      bytes,
      returned,
      length - returned,
      offset + BigInt(returned),
    );
    if (!read.bytesRead) break;
    returned += read.bytesRead;
  }
  return bytes.subarray(0, returned);
}

// Shared file admission and descriptor ownership also own cancellation during
// final close. Only the retention callback can transfer a failed-close owner.
async function withRegularFile(path, signal, operation) {
  await retainedHandles.retry();
  if (retainedHandles.size) {
    const blocked = error(
      "Earlier independent file cleanup remains incomplete",
      {
        cleanup: {
          reason: "Owned file close remains pending after retry",
          resources: [...retainedHandles.values()].map((entry) => entry.path),
        },
      },
    );
    new AnalysisCleanupLeaseGroup(
      blocked,
      [...retainedHandles.values()].map((entry) => entry.lease),
    );
    throw blocked;
  }
  try {
    return await withOwnedRegularFile(
      path,
      {
        signal,
        retainFailedClose: (owner) =>
          retainedHandles.retain(owner, {
            path,
            lease: AnalysisCleanupLease.forCloseOwner(owner, path),
          }),
      },
      async ({ handle }) =>
        operation(handle, await handle.stat({ bigint: true })),
    );
  } catch (cause) {
    const outcome =
      cause instanceof RegularFileCancelled ||
      cause instanceof RegularFileCleanupFailure
        ? cause.outcome
        : undefined;
    const partialObservation = {
      path,
      ...(outcome?.kind === "completed" ? { completed: outcome.value } : {}),
      ...(outcome?.kind === "failed"
        ? { primary_failure: outcome.cause?.message ?? String(outcome.cause) }
        : {}),
    };
    const cancelled = regularFileCancellation(cause);
    if (cause instanceof RegularFileCleanupFailure || cancelled) {
      const details = {
        cause: cancelled ? cancelled.reason : cause,
        partialObservation,
        ...(outcome?.kind === "failed" && outcome.cause instanceof AnalysisError
          ? { cleanupPrimary: outcome.cause }
          : {}),
        ...(cause instanceof RegularFileCleanupFailure
          ? {
              cleanup: {
                reason:
                  "Owned file close failed; automatic retry remains active",
                resources: [path],
              },
            }
          : {}),
      };
      const failure = cancelled
        ? new AnalysisCancelledError(OPERATION, details)
        : error("Independent file-read cleanup remains incomplete", details);
      if (cause instanceof RegularFileCleanupFailure)
        retainedHandles.get(cause.owner)?.lease.bindCleanupError(failure);
      throw failure;
    }
    throw cause;
  }
}

export const digestTarget = (path, signal) =>
  withRegularFile(path, signal, async (handle, before) => {
    const digest = await hashHandle(handle, before.size, signal);
    const after = await handle.stat({ bigint: true });
    assertRegularFileActive(signal);
    if (!stableMetadata(before, after))
      throw new AnalysisArtifactChangedError(
        OPERATION,
        path,
        "Target metadata changed during digest verification",
      );
    return digest;
  });

/** Retry cleanup without forgetting any file handle whose close still fails. */
export async function retryNativeByteCleanup() {
  return retainedHandles.retry();
}

async function verifyFile({
  path,
  mapping,
  length,
  nativeBytes,
  expectedDigest,
  signal,
}) {
  try {
    return await withRegularFile(path, signal, async (handle, before) => {
      if (mapping.offset + BigInt(length) > before.size)
        return {
          status: "unavailable",
          path,
          reason: "Mapped request exceeds the independent file's actual extent",
        };
      const bytes = await fileBytes(handle, mapping.offset, length, signal);
      const sha256 = await hashHandle(handle, before.size, signal);
      const after = await handle.stat({ bigint: true });
      const metadataStable = stableMetadata(before, after);
      const digestMatches = sha256 === expectedDigest;
      const bytesMatch =
        nativeBytes.length === length && bytes.equals(nativeBytes);
      return {
        status:
          metadataStable && digestMatches && bytesMatch
            ? "matched"
            : "unverified",
        path,
        file_offset: mapping.file_offset,
        returned_bytes: bytes.length,
        bytes_hex: bytes.toString("hex"),
        sha256,
        reader_digest_matches: digestMatches,
        metadata_stable: metadataStable,
        native_bytes_match: bytesMatch,
      };
    });
  } catch (cause) {
    if (cause instanceof AnalysisCancelledError || cause?.cleanup) throw cause;
    return {
      status: "unavailable",
      path,
      reason: cause?.message ?? "Independent file read failed",
      code: cause?.code ?? null,
    };
  }
}

async function assessCoverage({
  observation,
  sections,
  input,
  bytes,
  filePath,
  signal,
}) {
  const mapping = mapFileRange(sections, BigInt(input.address), input.length);
  const { offset, ...mappingFacts } = mapping;
  const unknowns = [];
  const target = observation.target;
  const digest = target?.sha256_before;
  const bound =
    target?.core_binding === "owned-process-opened-selected-path" &&
    typeof digest === "string" &&
    /^[0-9a-f]{64}$/iu.test(digest) &&
    digest === target.sha256_after;
  let verification = {
    status: "unavailable",
    reason:
      "No owned local file and unchanged reader digest bind this observation",
  };
  if (mapping.status !== "unique-initialized-section")
    unknowns.push(mapping.reason);
  if (filePath && bound && offset !== undefined)
    verification = await verifyFile({
      path: filePath,
      mapping,
      length: input.length,
      nativeBytes: bytes,
      expectedDigest: digest.toLowerCase(),
      signal,
    });
  if (verification.status !== "matched")
    unknowns.push(
      "Native bytes were not verified against initialized bytes of the reader's unchanged selected file",
    );
  if (bytes.length !== input.length)
    unknowns.push(
      "Native output is shorter than the requested range; remaining bytes are unknown",
    );
  return {
    complete: verification.status === "matched" ? true : null,
    coverage: {
      initialized_mapping: mappingFacts,
      file_verification: verification,
    },
    unknowns,
  };
}

/** Read one bounded native byte range; p8j padding alone never proves coverage. */
export async function readNativeBytes(input, read, filePath, request = {}) {
  const parsed = byteInputSchema.safeParse(input);
  if (!parsed.success) return err(new AnalysisInputError(OPERATION));
  const selected = parsed.data;
  let observation;
  let result;
  try {
    assertRegularFileActive(request.signal);
    const observed = await read(
      [
        { cmd: "iSj", json: true },
        { cmd: `p8j ${selected.length} @ ${selected.address}`, json: true },
      ],
      request,
    );
    if (!observed.ok) return observed;
    observation = observed.value;
    const sections = success(observation.replies, 0);
    const bytes = decodeBytes(success(observation.replies, 1), selected.length);
    result = {
      address: hex(BigInt(selected.address)),
      requested_bytes: selected.length,
      returned_bytes: bytes.length,
      bytes_hex: bytes.toString("hex"),
      complete: null,
    };
    Object.assign(
      result,
      await assessCoverage({
        observation,
        sections,
        input: selected,
        bytes,
        filePath,
        signal: request.signal,
      }),
    );
    result.limitations = [
      "p8j may pad unmapped reads; a returned byte count alone does not establish initialized coverage.",
      "Mapping uses the native iSj initialized size with its vaddr/paddr coordinates. Overlap, malformed coordinates, virtual tails and unknown external-core identity remain explicit unknowns.",
      "A verified range matches independently read bytes in a regular file whose digest matches the reader context and whose metadata remained stable during verification. This is a static byte comparison, not a runtime or relocation observation.",
    ];
    return ok({
      input: selected,
      target: observation.target,
      result,
      raw: observation.raw,
    });
  } catch (cause) {
    const partialObservation = {
      input: selected,
      ...(observation
        ? { target: observation.target, raw: observation.raw }
        : {}),
      ...(result ? { result } : {}),
    };
    const cancelled = regularFileCancellation(cause);
    return err(
      observationError(
        cancelled
          ? new AnalysisCancelledError(OPERATION, { cause: cancelled.reason })
          : cause,
        OPERATION,
        "Cannot complete native byte observation",
        partialObservation,
      ),
    );
  }
}
