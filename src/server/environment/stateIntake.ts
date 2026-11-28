import type { ReadableStreamReadResult } from "node:stream/web";
import { ResponseBodyCleanup } from "../../providers/ResponseBodyCleanup.js";
import { fileURLToPath } from "node:url";

import { mediaTypeEssence } from "../../domain/analysisView/recordedMediaType.js";
import {
  ArtifactResourceRetryFailure,
  type ArtifactResourceScope,
} from "../../resources/index.js";
import { STATE_INTAKE_LIMIT_BYTES } from "../../application/environment/environmentStateDocument.js";
import { isExactJsonNumber } from "../../domain/exactJsonNumber.js";
import { paddedBase64ByteLength } from "../../domain/paddedBase64.js";
import { err, ok, type Result } from "../../domain/result.js";
import { safeParseJson } from "../../domain/safeJson.js";
import {
  RegularFileCapacityError,
  readStableFileBytes,
} from "../../filesystem/readStableFileBytes.js";
import {
  RegularFileCleanupFailure,
  withOwnedRegularFile,
} from "../../filesystem/OwnedRegularFile.js";
import { decodeStrictUtf8 } from "../../domain/strictUtf8.js";
import {
  AbortedWait,
  waitForAbortable,
} from "../../process/AbortablePromise.js";
import { isRecord } from "../../kernel/isRecord.js";

/** Why a named file or download could not be read, or a call was cancelled: a category naming neither the uri nor the content. */
export type IntakeFailure =
  | "not-found"
  | "permission"
  | "not-regular-file"
  | "changed"
  | "read-failed"
  | "timeout"
  | "http-status"
  | "network"
  | "cancelled";

/** A JSON-RPC error the data plane answers with; `data` locates a document problem, names an intake failure or states the response budget. */
export interface RpcError {
  readonly code: number;
  readonly message: string;
  readonly data?:
    | { readonly path: string }
    | { readonly reason: IntakeFailure }
    | { readonly max_response_bytes: number; readonly reply_bytes: number };
}

const INVALID_PARAMS = -32602;
/** The data plane could not complete an operation whose params were valid. */
export const SERVER_ERROR = -32000;

/** A call the server's stop or its caller's departure ended before it could change the state. */
export const CANCELLED: RpcError = {
  code: SERVER_ERROR,
  message: "the call was cancelled and left the state unchanged",
  data: { reason: "cancelled" },
};

/** An https state download must finish within this time. */
const STATE_FETCH_TIMEOUT_MS = 30_000;

/** Fetches one https state document; injectable so tests make no external requests. */
export type StateFetcher = (url: URL, signal: AbortSignal) => Promise<Response>;

/** Redirects are refused so a download never leaves the https origin the caller named. */
const fetchStateDocument: StateFetcher = (url, signal) =>
  fetch(url, { signal, redirect: "error" });

/** How `data/add` reaches documents a uri names; injectable so tests make no external requests and need not wait. */
export interface StateIntake {
  readonly fetchState: StateFetcher;
  readonly timeoutMs: number;
}

/** The intake a served environment uses. */
export const DEFAULT_STATE_INTAKE: StateIntake = {
  fetchState: fetchStateDocument,
  timeoutMs: STATE_FETCH_TIMEOUT_MS,
};

/** Stands in for a number that native JSON parsing or serialization would change. */
const NOT_EXACT_JSON = Symbol("not exact JSON");

/** Mark values native parsing would change, so validation refuses them rather than storing an altered value. */
export const exactJsonReviver = (
  _key: string,
  value: unknown,
  context?: { readonly source?: string },
): unknown =>
  typeof value === "number" && !isExactJsonNumber(value, context?.source)
    ? NOT_EXACT_JSON
    : value;

export const invalidParams = (detail: string, path?: string): RpcError => ({
  code: INVALID_PARAMS,
  message: `invalid params: ${detail}`,
  ...(path === undefined ? {} : { data: { path } }),
});

const TOO_LARGE = invalidParams(
  `the state document exceeds ${String(STATE_INTAKE_LIMIT_BYTES)} bytes`,
);

const unreadable = (reason: IntakeFailure): RpcError => ({
  ...invalidParams("the file uri does not name a readable regular file"),
  data: { reason },
});

const fetchFailed = (reason: IntakeFailure): RpcError => ({
  code: SERVER_ERROR,
  message: "the state document could not be downloaded",
  data: { reason },
});

const FILE_FAILURES: ReadonlyMap<string, IntakeFailure> = new Map([
  ["ENOENT", "not-found"],
  ["ENOTDIR", "not-found"],
  ["EACCES", "permission"],
  ["EPERM", "permission"],
  ["EISDIR", "not-regular-file"],
  ["ENOTFILE", "not-regular-file"],
  ["ESTALE", "changed"],
]);

/** The coarse category of a file open or read failure, from its error code. */
const fileFailure = (cause: unknown): IntakeFailure =>
  (cause instanceof Error && "code" in cause
    ? FILE_FAILURES.get(String(cause.code))
    : undefined) ?? "read-failed";

const MAX_INLINE_BASE64_CHARACTERS =
  Math.ceil(STATE_INTAKE_LIMIT_BYTES / 3) * 4;

/** Parse loaded bytes as UTF-8 JSON, marking values parsing would change; the content is never echoed. */
const parseDocumentBytes = (bytes: Uint8Array): Result<unknown, RpcError> => {
  let text: string;
  try {
    // A user-saved JSON document may carry a BOM signature (RFC 8259 8.1).
    text = decodeStrictUtf8(bytes, "strip-signature");
  } catch {
    return err(invalidParams("the file is not UTF-8 text"));
  }
  const parsed = safeParseJson(text, exactJsonReviver);
  return parsed.ok
    ? ok(parsed.value)
    : err(invalidParams("the file is not JSON"));
};

const CLOSE_FAILED: RpcError = {
  code: SERVER_ERROR,
  message:
    "the state file could not be closed; the server retries the close before the next file read and at shutdown",
};

const STILL_OPEN: RpcError = {
  code: SERVER_ERROR,
  message:
    "an earlier state file is still open after its close failed, so no file was read",
};

/** Read one regular file within the intake limit; a descriptor whose close fails stays with `files`, which retries it before each later read. */
const readStateFile = async (
  path: string,
  files: ArtifactResourceScope,
): Promise<Result<Buffer, RpcError>> => {
  try {
    return ok(
      await files.run(() =>
        withOwnedRegularFile(
          path,
          {
            symlinks: "follow",
            retainFailedClose: (owner) =>
              files.retain({
                kind: "file-handle",
                resource: path,
                handle: owner,
              }),
          },
          ({ handle }) =>
            readStableFileBytes(handle, path, STATE_INTAKE_LIMIT_BYTES, {
              symlinks: "follow",
            }),
        ),
      ),
    );
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure) return err(CLOSE_FAILED);
    if (cause instanceof ArtifactResourceRetryFailure) return err(STILL_OPEN);
    return err(
      cause instanceof RegularFileCapacityError
        ? TOO_LARGE
        : unreadable(fileFailure(cause)),
    );
  }
};

/** What ends a download: its time limit or the caller's cancellation; `failure` names which, or a network failure when neither did. */
interface DownloadBounds {
  readonly signal: AbortSignal;
  readonly failure: () => IntakeFailure;
}

const downloadBounds = (
  timeoutMs: number,
  cancel: AbortSignal,
): DownloadBounds => {
  const timeout = AbortSignal.timeout(timeoutMs);
  return {
    signal: AbortSignal.any([timeout, cancel]),
    failure: () =>
      cancel.aborted ? "cancelled" : timeout.aborted ? "timeout" : "network",
  };
};

/** Cancel the stream's remaining work and return its reader lock. */
const cancelReader = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> => {
  try {
    await reader.cancel();
  } catch (cause: unknown) {
    // Cancel also rejects with the stored read error of an already errored
    // stream. A failed underlying cancel closes the stream and rejects only
    // cancel(), so that failure still belongs to the cleanup owner.
    const alreadyErrored = await reader.closed.then(
      () => false,
      () => true,
    );
    if (!alreadyErrored) throw cause;
  } finally {
    reader.releaseLock();
  }
};

const discardBody = (
  body: ReadableStream<Uint8Array> | null,
  responses: ResponseBodyCleanup,
): void => {
  if (body !== null) responses.cancel(() => cancelReader(body.getReader()));
};

/** Read a response body within the intake limit and the download's bounds, whether or not the fetcher ties the body to the signal. */
const readCapped = async (
  body: ReadableStream<Uint8Array> | null,
  bounds: DownloadBounds,
  responses: ResponseBodyCleanup,
): Promise<Result<Buffer, RpcError>> => {
  if (body === null) return ok(Buffer.alloc(0));
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let mustCancel = true;
  try {
    for (;;) {
      if (bounds.signal.aborted) return err(fetchFailed(bounds.failure()));
      let result: ReadableStreamReadResult<Uint8Array> | AbortedWait;
      try {
        result = await waitForAbortable(reader.read(), bounds.signal);
      } catch (cause: unknown) {
        // A rejected read already ended the stream. An error handling a
        // fulfilled chunk below can still leave the stream open.
        mustCancel = false;
        throw cause;
      }
      if (result instanceof AbortedWait)
        return err(fetchFailed(bounds.failure()));
      if (result.done) {
        mustCancel = false;
        return ok(Buffer.concat(chunks, total));
      }
      total += result.value.byteLength;
      if (total > STATE_INTAKE_LIMIT_BYTES) return err(TOO_LARGE);
      chunks.push(result.value);
    }
  } catch {
    return err(fetchFailed(bounds.failure()));
  } finally {
    // A tee's sibling can be caller-owned. Retain cancellation without waiting
    // for the sibling, and release the reader once the cancellation settles.
    if (mustCancel) responses.cancel(() => cancelReader(reader));
    else reader.releaseLock();
  }
};

/** Download one https document within the time and size limits, ending it when `cancel` aborts. */
const downloadState = async (
  url: URL,
  intake: StateIntake,
  cancel: AbortSignal,
  responses: ResponseBodyCleanup,
): Promise<Result<Buffer, RpcError>> => {
  const bounds = downloadBounds(intake.timeoutMs, cancel);
  const fetching = Promise.resolve().then(() =>
    intake.fetchState(url, bounds.signal),
  );
  let response: Response | AbortedWait;
  try {
    response = await waitForAbortable(fetching, bounds.signal);
  } catch {
    return err(fetchFailed(bounds.failure()));
  }
  if (response instanceof AbortedWait) {
    // A response that arrives after the download ended is released unread.
    void fetching
      .then(
        (late) => discardBody(late.body, responses),
        () => undefined,
      )
      .catch(() => undefined);
    return err(fetchFailed(bounds.failure()));
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (!response.ok || declared > STATE_INTAKE_LIMIT_BYTES) {
    // Cancel this branch without waiting for a potentially independent tee sibling.
    discardBody(response.body, responses);
    return err(
      response.ok
        ? TOO_LARGE
        : {
            ...fetchFailed("http-status"),
            message: `the state document download answered HTTP ${String(response.status)}`,
          },
    );
  }
  return readCapped(response.body, bounds, responses);
};

const NETWORK_SHARE = invalidParams(
  "a file:// uri names a path on this host, not a network share",
);

/** A path that names a host before its first segment, as `\\server\share` or `//server/share` does. */
const UNC_PATH = /^[\\/]{2}/u;

/** The local path a `file://` uri names; another host or a UNC path would open a network share, so neither is opened. */
const localFilePath = (url: URL): Result<string, RpcError> => {
  if (url.host !== "" && url.host !== "localhost") return err(NETWORK_SHARE);
  if (UNC_PATH.test(url.pathname)) return err(NETWORK_SHARE);
  let path: string;
  try {
    path = fileURLToPath(url);
  } catch {
    return err(invalidParams("a file:// uri names a local absolute path"));
  }
  return UNC_PATH.test(path) ? err(NETWORK_SHARE) : ok(path);
};

/** The bytes a file part carries inline or names by a `file://` or `https://` uri; `cancel` ends a download. */
const fileBytes = async (
  file: Readonly<Record<string, unknown>>,
  intake: StateIntake,
  cancel: AbortSignal,
  files: ArtifactResourceScope,
  responses: ResponseBodyCleanup,
): Promise<Result<Uint8Array, RpcError>> => {
  if (typeof file.bytes === "string" && file.uri === undefined) {
    if (file.bytes.length > MAX_INLINE_BASE64_CHARACTERS) return err(TOO_LARGE);
    const byteLength = paddedBase64ByteLength(file.bytes);
    if (byteLength === undefined)
      return err(invalidParams("the file part's bytes are not base64"));
    if (byteLength > STATE_INTAKE_LIMIT_BYTES) return err(TOO_LARGE);
    return ok(Buffer.from(file.bytes, "base64"));
  }
  if (
    typeof file.uri !== "string" ||
    file.bytes !== undefined ||
    !URL.canParse(file.uri)
  )
    return err(
      invalidParams("a file part carries exactly one of bytes or a uri"),
    );
  const url = new URL(file.uri);
  if (url.protocol === "https:")
    return downloadState(url, intake, cancel, responses);
  if (url.protocol !== "file:")
    return err(invalidParams("a file uri is a file:// or https:// URL"));
  const path = localFilePath(url);
  return path.ok ? readStateFile(path.value, files) : path;
};

/** The state document one `data/add` part carries, parsed but not yet validated; `cancel` ends a download and `files` owns file descriptors whose close failed. */
export const partDocument = async (
  part: unknown,
  intake: StateIntake,
  cancel: AbortSignal,
  files: ArtifactResourceScope,
  responses: ResponseBodyCleanup,
): Promise<Result<unknown, RpcError>> => {
  if (isRecord(part) && part.kind === "data" && isRecord(part.data))
    return ok(part.data);
  if (!isRecord(part) || part.kind !== "file" || !isRecord(part.file))
    return err(
      invalidParams(
        "a data/add part is a data part holding the document or a file part carrying it",
      ),
    );
  const { mimeType } = part.file;
  if (
    mimeType !== undefined &&
    (typeof mimeType !== "string" ||
      mediaTypeEssence(mimeType) !== "application/json")
  )
    return err(invalidParams("a file part's mimeType is application/json"));
  const bytes = await fileBytes(part.file, intake, cancel, files, responses);
  return bytes.ok ? parseDocumentBytes(bytes.value) : bytes;
};
