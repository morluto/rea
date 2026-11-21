import { BinaryReader } from "./binaryContainer.js";
import {
  withMzWindowsHeaderSignature,
  type MzHeaderEvidence,
  type MzWindowsHeaderObservation,
} from "./dosMz.js";
import { err, ok } from "./result.js";

const PE_SIGNATURE_BYTES = 4;
const PE_COFF_HEADER_BYTES = 20;
export const PE_COFF_FRAME_BYTES = PE_SIGNATURE_BYTES + PE_COFF_HEADER_BYTES;

type PeCoffFrame =
  | {
      readonly kind: "other";
      readonly observation: MzWindowsHeaderObservation;
    }
  | {
      readonly kind: "pe";
      readonly observation: Extract<
        MzWindowsHeaderObservation,
        { state: "declared" }
      >;
      readonly coff: ReturnType<typeof readPeCoffHeader>;
    };

/**
 * Borrow the signature and its COFF record in one bounded observation. A
 * short frame may still identify an NE/LE/LX signature or a truncated PE.
 * Drivers own exact-read behavior and consumers own format admission.
 */
export function* observePeCoffFrame(
  prefix: Buffer,
  fileSize: number,
  evidence: MzHeaderEvidence,
): Generator<
  { readonly offset: number; readonly size: number },
  PeCoffFrame,
  Buffer
> {
  const pending = evidence.windowsHeader;
  if (
    pending.state !== "signature-needed" &&
    !(pending.state === "declared" && pending.signature === "PE")
  )
    return { kind: "other", observation: pending };
  const { offset } = pending;
  const size = Math.min(PE_COFF_FRAME_BYTES, Math.max(0, fileSize - offset));
  const cached = offset + size <= prefix.length;
  const frame = cached
    ? prefix.subarray(offset, offset + size)
    : yield { offset, size };
  const observation =
    cached && pending.state === "declared"
      ? pending
      : withMzWindowsHeaderSignature(prefix, fileSize, evidence, {
          offset,
          bytes: frame,
        }).windowsHeader;
  return observation.state === "declared" && observation.signature === "PE"
    ? {
        kind: "pe",
        observation,
        coff: readPeCoffHeader(frame.subarray(PE_SIGNATURE_BYTES)),
      }
    : { kind: "other", observation };
}

/** Fixed 20-byte COFF record, excluding the PE signature; callers own admission. */
export const readPeCoffHeader = (bytes: Buffer) => {
  if (bytes.length < PE_COFF_HEADER_BYTES)
    return err({
      kind: "malformed" as const,
      message: "PE COFF header is truncated",
    });
  const record = new BinaryReader(bytes, true, "pe");
  return ok({
    machine: record.u16(0),
    sectionCount: record.u16(2),
    symbolTableOffset: record.u32(8),
    symbolCount: record.u32(12),
    optionalHeaderSize: record.u16(16),
    characteristics: record.u16(18),
  });
};
