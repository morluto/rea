import { BinaryReader } from "../domain/binaryContainer.js";
import { errorMessage } from "../kernel/errorMessage.js";

/** Size of the UpgradeableLoaderState::ProgramData header before the ELF. */
const PROGRAM_DATA_METADATA_BYTES = 45;

/** Bounds-checked little-endian reader over account data. */
const littleEndianReader = (bytes: Uint8Array): BinaryReader =>
  new BinaryReader(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    true,
    "solana-account",
  );

/** Expected RPC intake failure (transport, account shape, or layout). */
export class SolanaRpcFailure extends Error {}

/** The endpoint's response or account data exceeds the fixed intake allowance. */
export class SolanaRpcResponseTooLarge extends SolanaRpcFailure {
  constructor(
    message: string,
    readonly maximumBytes: number,
  ) {
    super(message);
  }
}

export const BPF_LOADER_UPGRADEABLE =
  "BPFLoaderUpgradeab1e11111111111111111111111";
/** Non-upgradeable loaders whose executable program accounts hold the ELF directly. */
export const DIRECT_ELF_LOADERS: ReadonlySet<string> = new Set([
  "BPFLoader2111111111111111111111111111111111",
  "BPFLoader1111111111111111111111111111111111",
]);
/** Default executable-bytes allowance; ProgramData headers are at most 45 bytes. */
export const DEFAULT_MAX_PROGRAM_BYTES = 64 * 1024 * 1024;
const PROGRAM_DATA_HEADER_BYTES = 45;
/** Envelope allowance beyond the base64 payload (JSON keys, owner, slot). */
const RPC_ENVELOPE_SLACK_BYTES = 64 * 1024;

/** Credential-free endpoint label for errors: scheme and host only. */
const endpointLabel = (rpcUrl: string): string =>
  URL.parse(rpcUrl)?.origin ?? "the selected endpoint";

/**
 * Read a response body while counting bytes, refusing as soon as the
 * running total passes `maximumBytes`, so a hostile or faulty endpoint
 * cannot make REA buffer an unbounded body before the size check.
 */
const readBoundedBody = async (
  response: Response,
  maximumBytes: number,
): Promise<string> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes)
    throw new SolanaRpcResponseTooLarge(
      `Solana RPC response declares ${String(declared)} bytes, above the ${String(maximumBytes)}-byte allowance.`,
      maximumBytes,
    );
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SolanaRpcResponseTooLarge(
        `Solana RPC response exceeded the ${String(maximumBytes)}-byte allowance.`,
        maximumBytes,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString("utf8");
};

/** Exact decoded length of a base64 string, computed before any allocation. */
const base64DecodedLength = (encoded: string): number => {
  let padding = 0;
  if (encoded.endsWith("==")) padding = 2;
  else if (encoded.endsWith("=")) padding = 1;
  return Math.floor((encoded.length * 3) / 4) - padding;
};
export const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decode a base58 string with Node stdlib only; undefined when malformed. */
export const decodeBase58 = (value: string): Uint8Array | undefined => {
  if (value.length === 0) return undefined;
  let leadingZeros = 0;
  while (leadingZeros < value.length && value[leadingZeros] === "1")
    leadingZeros += 1;
  const size =
    Math.floor(((value.length - leadingZeros) * Math.log(58)) / Math.log(256)) +
    1;
  const bytes = new Uint8Array(size);
  let length = 0;
  for (let index = leadingZeros; index < value.length; index += 1) {
    const digit = BASE58_ALPHABET.indexOf(value[index] ?? "");
    if (digit < 0) return undefined;
    let carry = digit;
    let consumed = 0;
    for (
      let position = size - 1;
      position >= 0 && (carry !== 0 || consumed < length);
      position -= 1
    ) {
      carry += 58 * (bytes[position] ?? 0);
      bytes[position] = carry % 256;
      carry = Math.floor(carry / 256);
      consumed += 1;
    }
    if (carry !== 0) return undefined;
    length = consumed;
  }
  let start = size - length;
  while (start < size && bytes[start] === 0) start += 1;
  const result = new Uint8Array(leadingZeros + (size - start));
  result.set(bytes.subarray(start), leadingZeros);
  return result;
};

/** Encode bytes as base58 (used for the ProgramData account address). */
export const encodeBase58 = (bytes: Uint8Array): string => {
  if (bytes.length === 0) return "";
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0)
    leadingZeros += 1;
  const size =
    Math.floor(((bytes.length - leadingZeros) * Math.log(256)) / Math.log(58)) +
    1;
  const digits = new Uint8Array(size);
  let length = 0;
  for (let index = leadingZeros; index < bytes.length; index += 1) {
    let carry = bytes[index] ?? 0;
    let consumed = 0;
    for (
      let position = size - 1;
      position >= 0 && (carry !== 0 || consumed < length);
      position -= 1
    ) {
      carry += 256 * (digits[position] ?? 0);
      digits[position] = carry % 58;
      carry = Math.floor(carry / 58);
      consumed += 1;
    }
    length = consumed;
  }
  let start = size - length;
  while (start < size && digits[start] === 0) start += 1;
  let result = "1".repeat(leadingZeros);
  for (let index = start; index < size; index += 1)
    result += BASE58_ALPHABET[digits[index] ?? 0] ?? "1";
  return result;
};

export interface SolanaProgramFetch {
  readonly elfBytes: Uint8Array;
  readonly programDataAccount: string | null;
  readonly slot: number | null;
}

interface AccountInfo {
  readonly data: Uint8Array;
  readonly owner: string;
  readonly executable: boolean;
}

type FetchLike = typeof fetch;

/** One JSON-RPC getAccountInfo call with base64 encoding; null when absent. */
const getAccountInfo = async (
  fetchImpl: FetchLike,
  rpcUrl: string,
  address: string,
  signal: AbortSignal | undefined,
  maximumDataBytes: number,
): Promise<AccountInfo | null> => {
  let response: Response;
  try {
    response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [address, { encoding: "base64", commitment: "finalized" }],
      }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    if (signal?.aborted === true) throw cause;
    throw new SolanaRpcFailure(
      `Solana RPC request to ${endpointLabel(rpcUrl)} failed: ${errorMessage(cause)}`,
      { cause },
    );
  }
  if (!response.ok)
    throw new SolanaRpcFailure(
      `Solana RPC ${endpointLabel(rpcUrl)} answered HTTP ${String(response.status)}.`,
    );
  const body = await readBoundedBody(
    response,
    Math.ceil((maximumDataBytes * 4) / 3) + RPC_ENVELOPE_SLACK_BYTES,
  );
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (cause) {
    throw new SolanaRpcFailure("Solana RPC answered non-JSON content.", {
      cause,
    });
  }
  if (typeof payload !== "object" || payload === null)
    throw new SolanaRpcFailure("Solana RPC answered a malformed envelope.");
  const envelope = payload as {
    readonly result?: { readonly value?: unknown } | null;
    readonly error?: { readonly message?: string } | null;
  };
  if (envelope.error !== null && envelope.error !== undefined)
    throw new SolanaRpcFailure(
      `Solana RPC error: ${envelope.error.message ?? "unknown"}.`,
    );
  const value = envelope.result?.value;
  if (value === null || value === undefined) return null;
  if (typeof value !== "object")
    throw new SolanaRpcFailure("Solana RPC account value is malformed.");
  const account = value as {
    readonly data?: unknown;
    readonly owner?: unknown;
    readonly executable?: unknown;
  };
  const dataField = account.data;
  if (
    !Array.isArray(dataField) ||
    typeof dataField[0] !== "string" ||
    dataField[1] !== "base64"
  )
    throw new SolanaRpcFailure(
      "Solana RPC account data did not arrive as base64.",
    );
  const encoded = dataField[0];
  const decodedLength = base64DecodedLength(encoded);
  if (decodedLength > maximumDataBytes)
    throw new SolanaRpcResponseTooLarge(
      `Account ${address} holds ${String(decodedLength)} bytes, above the ${String(maximumDataBytes)}-byte allowance.`,
      maximumDataBytes,
    );
  return {
    // One decode into one buffer; no second copy.
    data: Buffer.from(encoded, "base64"),
    owner: typeof account.owner === "string" ? account.owner : "",
    executable: account.executable === true,
  };
};

/**
 * Fetch a program's executable bytes read-only. Upgradeable-loader programs
 * resolve through their ProgramData account (4-byte tag 3, u64 slot,
 * optional authority); legacy-loader accounts hold the ELF directly.
 */
export const fetchSolanaProgramElf = async (
  programId: string,
  rpcUrl: string,
  options: {
    readonly signal?: AbortSignal;
    readonly fetchImpl?: FetchLike;
    /** Executable-bytes allowance; account data is refused before decoding past it. */
    readonly maxProgramBytes?: number;
  } = {},
): Promise<SolanaProgramFetch> => {
  const maxProgramBytes = options.maxProgramBytes ?? DEFAULT_MAX_PROGRAM_BYTES;
  const maxAccountBytes = maxProgramBytes + PROGRAM_DATA_HEADER_BYTES;
  const decoded = decodeBase58(programId);
  if (decoded === undefined || decoded.length !== 32)
    throw new SolanaRpcFailure(
      `Program id ${programId} is not a base58-encoded 32-byte public key.`,
    );
  const fetchImpl = options.fetchImpl ?? fetch;
  const account = await getAccountInfo(
    fetchImpl,
    rpcUrl,
    programId,
    options.signal,
    maxAccountBytes,
  );
  if (account === null)
    throw new SolanaRpcFailure(
      `No account exists at ${programId} on the selected endpoint.`,
    );
  // Only an executable program account selects a deployed program; a data
  // account that happens to start with ELF magic is not program evidence.
  if (!account.executable)
    throw new SolanaRpcFailure(
      `Account ${programId} is not executable, so it is not a deployed program account.`,
    );
  if (account.owner !== BPF_LOADER_UPGRADEABLE) {
    if (
      DIRECT_ELF_LOADERS.has(account.owner) &&
      account.data[0] === 0x7f &&
      account.data[1] === 0x45 &&
      account.data[2] === 0x4c &&
      account.data[3] === 0x46
    )
      return {
        elfBytes: account.data,
        programDataAccount: null,
        slot: null,
      };
    throw new SolanaRpcFailure(
      `Account ${programId} is owned by ${account.owner || "an unknown program"}; only executable accounts of BPF Loader 1/2 (ELF held directly) or BPF Loader Upgradeable (ELF in ProgramData) are accepted.`,
    );
  }
  if (account.data.length < 36 || littleEndianReader(account.data).u32(0) !== 2)
    throw new SolanaRpcFailure(
      `Account ${programId} is not an upgradeable Program account.`,
    );
  const programDataAccount = encodeBase58(account.data.subarray(4, 36));
  const programData = await getAccountInfo(
    fetchImpl,
    rpcUrl,
    programDataAccount,
    options.signal,
    maxAccountBytes,
  );
  if (programData === null)
    throw new SolanaRpcFailure(
      `ProgramData account ${programDataAccount} for ${programId} was not found.`,
    );
  if (programData.owner !== BPF_LOADER_UPGRADEABLE)
    throw new SolanaRpcFailure(
      `ProgramData account ${programDataAccount} is owned by ${programData.owner || "an unknown program"}, not BPF Loader Upgradeable.`,
    );
  const data = programData.data;
  const dataReader = littleEndianReader(data);
  if (data.length < 13 || dataReader.u32(0) !== 3)
    throw new SolanaRpcFailure(
      `ProgramData account ${programDataAccount} has an unexpected layout.`,
    );
  const slot = Number(dataReader.word(4, 64));
  // ProgramData reserves a fixed 45-byte header (tag, slot, and an
  // Option<Pubkey> authority slot) whether or not an authority is set.
  const elfStart = PROGRAM_DATA_METADATA_BYTES;
  if (data.length <= elfStart)
    throw new SolanaRpcFailure(
      `ProgramData account ${programDataAccount} carries no ELF bytes.`,
    );
  return {
    elfBytes: data.subarray(elfStart),
    programDataAccount,
    slot,
  };
};
