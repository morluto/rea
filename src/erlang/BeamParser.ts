import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import {
  ArtifactReaderFailure,
  type StableArtifactHandle,
} from "../resources/index.js";
import { BinaryReader } from "../domain/binaryContainer.js";
import { decodeLimit } from "../domain/parseFailure.js";
import {
  MAX_INSPECT_ERLANG_BEAM_TABLE_ROWS,
  type ErlangBeam,
  type InspectErlangBeamInput,
} from "../domain/erlang/beam.js";
import { sha256Hex } from "../kernel/sha256Hex.js";

const fail = (message: string): never => {
  throw new ArtifactReaderFailure("format", message);
};

const LIMITATIONS = [
  "This workflow does not execute BEAM bytecode, inflate LitT literals, or decode Attr/CInf external-term payloads.",
  "Atom names are structural table entries; they do not authenticate the originating compiler or module checksum.",
] as const;

const STREAM_CHUNK_BYTES = 1024 * 1024;
const RETAINED_TABLE_CHUNKS = new Set(["AtU8", "Atom", "ExpT", "ImpT", "FunT"]);
const CODE_HEADER_BYTES = 20;

const requireRange = (
  fileSize: number,
  offset: number,
  length: number,
): void => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > fileSize - length
  )
    fail(
      `BEAM range ${String(offset)} + ${String(length)} leaves the artifact.`,
    );
};

const atomAt = (
  atoms: readonly { index: number; name: string }[] | null,
  index: number,
): string | null => {
  if (atoms === null || index < 1) return null;
  return atoms[index - 1]?.name ?? null;
};

/** Reads an atom length: one byte, or OTP 28+ compact `u` tag when compact. */
const atomLength = (
  payload: Buffer,
  at: number,
  compact: boolean,
): [length: number, next: number] => {
  if (at >= payload.length) fail("BEAM atom table is truncated.");
  const first = payload[at]!;
  if (!compact) return [first, at + 1];
  const decoded = compactUnsigned(payload, at);
  if (decoded.value > BigInt(payload.length - decoded.next))
    fail("BEAM atom table is truncated.");
  return [Number(decoded.value), decoded.next];
};

/** Decode OTP's compact unsigned `u` tag without allocating from its value. */
const compactUnsigned = (
  payload: Buffer,
  at: number,
): { value: bigint; next: number } => {
  let cursor = at;
  let value: bigint;
  for (;;) {
    if (cursor >= payload.length) fail("BEAM atom table is truncated.");
    const first = payload[cursor]!;
    if ((first & 0x07) !== 0) fail("BEAM atom length is not a u tag.");
    if ((first & 0x08) === 0) {
      value = BigInt(first >> 4);
      cursor += 1;
      break;
    }
    if ((first & 0x10) === 0) {
      if (cursor + 1 >= payload.length) fail("BEAM atom table is truncated.");
      value = BigInt(((first >> 5) << 8) | payload[cursor + 1]!);
      cursor += 2;
      break;
    }
    const byteCountCode = first >> 5;
    cursor += 1;
    // OTP's size-of-size form always produces at least a 9-byte integer.
    // unpack_varint rejects any value wider than SWord, even with leading
    // zeroes, so no unsigned atom length can be represented by this form.
    if (byteCountCode === 7) fail("BEAM atom length encoding overflows.");
    value = readCompactUnsignedBytes(payload, cursor, byteCountCode + 2);
    cursor += byteCountCode + 2;
    break;
  }
  return { value, next: cursor };
};

const readCompactUnsignedBytes = (
  payload: Buffer,
  at: number,
  byteCount: number,
): bigint => {
  if (byteCount > payload.length - at) fail("BEAM atom table is truncated.");
  // OTP's unpack_varint only accepts values that fit a signed machine word.
  // For REA's supported 64-bit runtime target, that is at most eight bytes.
  const maxValue = 9_223_372_036_854_775_807n;
  let value = 0n;
  for (let index = 0; index < byteCount; index += 1) {
    const byte = BigInt(payload[at + index]!);
    if (value > (maxValue - byte) >> 8n)
      fail("BEAM atom length encoding overflows.");
    value = (value << 8n) | byte;
  }
  return value;
};

const parseAtoms = (
  payload: Buffer,
  maxAtoms: number,
  format: "Atom" | "AtU8",
): {
  readonly atoms: NonNullable<ErlangBeam["atoms"]>;
  readonly trailingBytes: number;
} => {
  if (payload.length < 4) fail("BEAM atom table is truncated.");
  // Only AtU8 supports OTP 28+'s negated count and compact name lengths.
  // Historical Atom uses an unsigned count and single-byte lengths.
  const encoding = format === "AtU8" ? "utf8" : "latin1";
  const rawCount = new BinaryReader(payload, false, "beam").u32(0);
  const declared = format === "AtU8" ? rawCount | 0 : rawCount;
  const compact = format === "AtU8" && declared < 0;
  const count = compact ? -declared : declared;
  // Every entry needs at least one length byte, regardless of the layout.
  // Reject an impossible table before treating its count as a budget refusal.
  if (count > payload.length - 4) fail("BEAM atom table is truncated.");
  const overBudget = count > maxAtoms;
  const atoms: NonNullable<ErlangBeam["atoms"]> = [];
  const examined = Math.min(count, maxAtoms);
  let at = 4;
  for (let index = 1; index <= examined; index += 1) {
    const [length, next] = atomLength(payload, at, compact);
    // Reserve at least one length byte per remaining atom. A length inside
    // the admitted prefix can disprove framing without inspecting those rows.
    if (length > payload.length - next - (count - index))
      fail("BEAM atom table is truncated.");
    at = next + length;
    if (overBudget) continue;
    const nameBytes = payload.subarray(next, at);
    if (encoding === "utf8" && !isUtf8(nameBytes))
      fail("BEAM atom name is not valid UTF-8.");
    atoms.push({ index, name: nameBytes.toString(encoding) });
  }
  if (overBudget)
    throw decodeLimit(
      "beam",
      `BEAM atom table exceeds the ${String(maxAtoms)}-atom budget.`,
      { name: "max_atoms", maximum: maxAtoms, required: count },
    );
  return { atoms, trailingBytes: payload.length - at };
};

const frameRows = (payload: Buffer, width: number, label: string) => {
  if (payload.length < 4) fail(`BEAM ${label} table is truncated.`);
  const reader = new BinaryReader(payload, false, "beam");
  const count = reader.u32(0);
  const rowBytes = width * 4;
  const bytesRead = 4 + count * rowBytes;
  if (bytesRead > payload.length) fail(`BEAM ${label} table is truncated.`);
  return { reader, count, rowBytes, trailingBytes: payload.length - bytesRead };
};

const mapRows = <Row>(
  { reader, count, rowBytes }: ReturnType<typeof frameRows>,
  project: (reader: BinaryReader, start: number) => Row,
): Row[] => {
  const rows: Row[] = [];
  for (let index = 0; index < count; index += 1)
    rows.push(project(reader, 4 + index * rowBytes));
  return rows;
};

const parseCode = (
  header: Buffer,
  payloadLength: number,
  chunkOffset: number,
): NonNullable<ErlangBeam["code"]> => {
  if (payloadLength < CODE_HEADER_BYTES || header.length < CODE_HEADER_BYTES)
    fail("BEAM Code chunk is truncated.");
  const reader = new BinaryReader(header, false, "beam");
  const infoSize = reader.u32(0);
  if (infoSize < 16 || infoSize > payloadLength - 4)
    fail("BEAM Code header size is invalid.");
  const instructionsOffset = 4 + infoSize;
  return {
    instruction_set: reader.u32(4),
    opcode_max: reader.u32(8),
    labels: reader.u32(12),
    functions: reader.u32(16),
    extra_header_bytes: infoSize - 16,
    instructions: {
      offset: chunkOffset + 8 + instructionsOffset,
      bytes: payloadLength - instructionsOffset,
    },
  };
};

interface RetainedBeamChunk {
  readonly payload: Buffer;
  readonly payloadLength: number;
  readonly offset: number;
}

const buildErlangBeamReport = (
  fileSize: number,
  formSize: number,
  formEnd: number,
  chunks: ErlangBeam["chunks"],
  payloads: ReadonlyMap<string, RetainedBeamChunk>,
  artifact: ErlangBeam["artifact"],
  input: InspectErlangBeamInput,
): ErlangBeam => {
  const utf8AtomChunk = payloads.get("AtU8");
  const legacyAtomChunk = payloads.get("Atom");
  // Historical OTP selects Atom when AtU8 has no payload. Without a legacy
  // table, a present empty AtU8 still fails its required count header.
  const useUtf8Atoms =
    utf8AtomChunk !== undefined &&
    (utf8AtomChunk.payload.length > 0 || legacyAtomChunk === undefined);
  const atomChunk = useUtf8Atoms ? utf8AtomChunk : legacyAtomChunk;
  const atomFormat =
    atomChunk === undefined ? null : useUtf8Atoms ? "AtU8" : "Atom";
  const atomEncoding =
    atomFormat === null ? null : atomFormat === "AtU8" ? "utf8" : "latin1";
  const atomTable =
    atomChunk === undefined || atomFormat === null
      ? null
      : parseAtoms(atomChunk.payload, input.max_atoms, atomFormat);
  const atoms = atomTable?.atoms ?? null;
  const exportChunk = payloads.get("ExpT");
  const importChunk = payloads.get("ImpT");
  const lambdaChunk = payloads.get("FunT");
  const exportTable =
    exportChunk === undefined
      ? null
      : frameRows(exportChunk.payload, 3, "export");
  const importTable =
    importChunk === undefined
      ? null
      : frameRows(importChunk.payload, 3, "import");
  // OTP skips the optional lambda parser for a zero-byte selected chunk.
  const lambdaTable =
    lambdaChunk === undefined || lambdaChunk.payload.length === 0
      ? null
      : frameRows(lambdaChunk.payload, 6, "lambda");
  const tableRows =
    (exportTable?.count ?? 0) +
    (importTable?.count ?? 0) +
    (lambdaTable?.count ?? 0);
  if (tableRows > MAX_INSPECT_ERLANG_BEAM_TABLE_ROWS)
    throw decodeLimit(
      "beam",
      `BEAM tables exceed the ${String(MAX_INSPECT_ERLANG_BEAM_TABLE_ROWS)}-row budget.`,
      {
        name: "max_table_rows",
        maximum: MAX_INSPECT_ERLANG_BEAM_TABLE_ROWS,
        required: tableRows,
      },
    );
  const exports =
    exportTable === null
      ? null
      : mapRows(exportTable, (reader, start) => {
          const functionIndex = reader.u32(start);
          return {
            function_index: functionIndex,
            function: atomAt(atoms, functionIndex),
            arity: reader.u32(start + 4),
            label: reader.u32(start + 8),
          };
        });
  const imports =
    importTable === null
      ? null
      : mapRows(importTable, (reader, start) => {
          const moduleIndex = reader.u32(start);
          const functionIndex = reader.u32(start + 4);
          return {
            module_index: moduleIndex,
            module: atomAt(atoms, moduleIndex),
            function_index: functionIndex,
            function: atomAt(atoms, functionIndex),
            arity: reader.u32(start + 8),
          };
        });
  // A four-byte zero count remains a decoded, explicitly empty table.
  const lambdas =
    lambdaTable === null
      ? null
      : mapRows(lambdaTable, (reader, start) => {
          const functionIndex = reader.u32(start);
          return {
            function_index: functionIndex,
            function: atomAt(atoms, functionIndex),
            arity: reader.u32(start + 4),
            label: reader.u32(start + 8),
            index: reader.u32(start + 12),
            free_vars: reader.u32(start + 16),
            old_unique: reader.u32(start + 20),
          };
        });
  const codeChunk = payloads.get("Code");
  const code =
    codeChunk === undefined
      ? null
      : parseCode(codeChunk.payload, codeChunk.payloadLength, codeChunk.offset);
  // A conformant FOR1 form sizes itself to the file; any surplus bytes trail an
  // unexamined region. Disclose them instead of reporting complete coverage.
  const trailingBytes = fileSize - formEnd;
  const unexamined: string[] = [];
  if (trailingBytes > 0)
    unexamined.push(
      `The declared FOR1 form ends at offset ${String(formEnd)}; ${String(trailingBytes)} trailing ${trailingBytes === 1 ? "byte was" : "bytes were"} not examined.`,
    );
  const tableTails = [
    [atomFormat, atomTable?.trailingBytes ?? 0],
    ["ExpT", exportTable?.trailingBytes ?? 0],
    ["ImpT", importTable?.trailingBytes ?? 0],
    ["FunT", lambdaTable?.trailingBytes ?? 0],
  ] as const;
  for (const [name, extra] of tableTails) {
    if (extra > 0)
      unexamined.push(
        `The selected ${name} table has ${String(extra)} trailing ${extra === 1 ? "byte that was" : "bytes that were"} not examined.`,
      );
  }
  return {
    artifact,
    form: { location: { offset: 0, bytes: formEnd }, size: formSize },
    chunks,
    atoms,
    atom_encoding: atomEncoding,
    exports,
    imports,
    lambdas,
    code,
    module: atoms?.[0]?.name ?? null,
    coverage: {
      status: unexamined.length > 0 ? "partial" : "complete",
      examined_chunks: chunks.length,
      atoms: atoms?.length ?? 0,
      trailing_bytes: trailingBytes,
    },
    limitations: [...LIMITATIONS, ...unexamined],
  };
};

/** Decode one FOR1/BEAM IFF container into bounded chunk and table facts. */
export const parseErlangBeam = (
  bytes: Buffer,
  artifact: ErlangBeam["artifact"],
  input: InspectErlangBeamInput,
): ErlangBeam => {
  requireRange(bytes.length, 0, 12);
  if (bytes.subarray(0, 4).toString("latin1") !== "FOR1")
    fail("Expected a FOR1 IFF container.");
  const carrier = new BinaryReader(bytes, false, "beam");
  const formSize = carrier.u32(4);
  if (formSize < 4) fail("BEAM form size is shorter than the BEAM tag.");
  requireRange(bytes.length, 8, formSize);
  if (bytes.subarray(8, 12).toString("latin1") !== "BEAM")
    fail("Expected a BEAM form type.");
  const formEnd = 8 + formSize;
  const form = new BinaryReader(
    carrier.range(0, formEnd, "BEAM form"),
    false,
    "beam",
  );
  const chunks: ErlangBeam["chunks"] = [];
  const payloads = new Map<string, RetainedBeamChunk>();
  let at = 12;
  while (at < formEnd) {
    if (formEnd - at < 8) fail("BEAM chunk header is truncated.");
    const size = form.u32(at + 4);
    const payloadOffset = at + 8;
    if (size > formEnd - payloadOffset)
      fail("BEAM chunk payload exceeds the form.");
    const padded = payloadOffset + size + ((4 - (size % 4)) % 4);
    if (padded > formEnd) fail("BEAM chunk padding exceeds the form.");
    if (chunks.length >= input.max_chunks)
      throw decodeLimit(
        "beam",
        `BEAM form exceeds the ${String(input.max_chunks)}-chunk budget.`,
        { name: "max_chunks", maximum: input.max_chunks },
      );
    const name = form.range(at, 4, "BEAM chunk name").toString("latin1");
    const payload = form.range(payloadOffset, size, "BEAM chunk payload");
    chunks.push({
      index: chunks.length,
      name,
      location: { offset: at, bytes: padded - at },
      payload: {
        location: { offset: payloadOffset, bytes: size },
        bytes: size,
        sha256: sha256Hex(payload),
      },
    });
    // OTP's loader replaces the selected payload on each matching chunk.
    // Keep every occurrence above; decode the last occurrence of each name.
    payloads.set(name, { payload, payloadLength: size, offset: at });
    at = padded;
  }
  return buildErlangBeamReport(
    bytes.length,
    formSize,
    formEnd,
    chunks,
    payloads,
    artifact,
    input,
  );
};

const streamChunkDigest = async (
  handle: StableArtifactHandle,
  payloadOffset: number,
  size: number,
  retainPrefixBytes: number,
): Promise<{ readonly sha256: string; readonly prefix: Buffer }> => {
  const hash = createHash("sha256");
  const prefix = Buffer.alloc(Math.min(size, retainPrefixBytes));
  for (let offset = 0; offset < size; offset += STREAM_CHUNK_BYTES) {
    const length = Math.min(STREAM_CHUNK_BYTES, size - offset);
    const part = await handle.readRange(payloadOffset + offset, length);
    if (part.length !== length)
      throw new ArtifactReaderFailure(
        "integrity",
        "BEAM payload ended before its admitted extent.",
        { integrityCheck: "read-coverage" },
      );
    hash.update(part);
    if (offset < prefix.length)
      part.copy(
        prefix,
        offset,
        0,
        Math.min(part.length, prefix.length - offset),
      );
  }
  return { sha256: hash.digest("hex"), prefix };
};

/**
 * Decode one FOR1/BEAM IFF container from a verified random-access handle,
 * retaining only decoded table chunks and the 20-byte Code header while
 * streaming SHA-256 digests over bulk chunks such as Code, Dbgi, and LitT.
 */
export const parseErlangBeamFromHandle = async (
  handle: StableArtifactHandle,
  artifact: ErlangBeam["artifact"],
  input: InspectErlangBeamInput,
): Promise<ErlangBeam> => {
  requireRange(handle.size, 0, 12);
  const header =
    handle.prefix.length >= 12
      ? handle.prefix.subarray(0, 12)
      : await handle.readRange(0, 12);
  if (header.subarray(0, 4).toString("latin1") !== "FOR1")
    fail("Expected a FOR1 IFF container.");
  const formSize = new BinaryReader(header, false, "beam").u32(4);
  if (formSize < 4) fail("BEAM form size is shorter than the BEAM tag.");
  requireRange(handle.size, 8, formSize);
  if (header.subarray(8, 12).toString("latin1") !== "BEAM")
    fail("Expected a BEAM form type.");
  const formEnd = 8 + formSize;
  const chunks: ErlangBeam["chunks"] = [];
  const payloads = new Map<string, RetainedBeamChunk>();
  let at = 12;
  while (at < formEnd) {
    if (formEnd - at < 8) fail("BEAM chunk header is truncated.");
    const chunkHeader = await handle.readRange(at, 8);
    const size = new BinaryReader(chunkHeader, false, "beam").u32(4);
    const payloadOffset = at + 8;
    if (size > formEnd - payloadOffset)
      fail("BEAM chunk payload exceeds the form.");
    const padded = payloadOffset + size + ((4 - (size % 4)) % 4);
    if (padded > formEnd) fail("BEAM chunk padding exceeds the form.");
    if (chunks.length >= input.max_chunks)
      throw decodeLimit(
        "beam",
        `BEAM form exceeds the ${String(input.max_chunks)}-chunk budget.`,
        { name: "max_chunks", maximum: input.max_chunks },
      );
    const name = chunkHeader.subarray(0, 4).toString("latin1");
    let sha256: string;
    if (RETAINED_TABLE_CHUNKS.has(name)) {
      const payload =
        size === 0
          ? Buffer.alloc(0)
          : await handle.readRange(payloadOffset, size);
      sha256 = sha256Hex(payload);
      payloads.set(name, { payload, payloadLength: size, offset: at });
    } else if (name === "Code") {
      const streamed = await streamChunkDigest(
        handle,
        payloadOffset,
        size,
        CODE_HEADER_BYTES,
      );
      sha256 = streamed.sha256;
      payloads.set(name, {
        payload: streamed.prefix,
        payloadLength: size,
        offset: at,
      });
    } else {
      const streamed = await streamChunkDigest(handle, payloadOffset, size, 0);
      sha256 = streamed.sha256;
    }
    chunks.push({
      index: chunks.length,
      name,
      location: { offset: at, bytes: padded - at },
      payload: {
        location: { offset: payloadOffset, bytes: size },
        bytes: size,
        sha256,
      },
    });
    at = padded;
  }
  return buildErlangBeamReport(
    handle.size,
    formSize,
    formEnd,
    chunks,
    payloads,
    artifact,
    input,
  );
};
