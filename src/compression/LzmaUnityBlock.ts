import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import {
  assertArtifactReadActive,
  yieldArtifactRead,
} from "../resources/index.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../domain/binaryContainer.js";
import {
  checkLzma1RangeCoderLeadIn,
  lzma1AloneFromRaw,
  type Lzma1Refusal,
} from "./Lzma1.js";
import { readLzma1AloneHeader } from "./Lzma1Header.js";

type WorkerReply =
  | {
      readonly ok: true;
      readonly buffer: ArrayBuffer;
      readonly byteLength: number;
    }
  | {
      readonly ok: false;
      readonly kind: Lzma1Refusal["kind"];
      readonly message: string;
    };

const rejectLzma = (message: string): never => {
  throw new BinaryFormatFailure("malformed", message);
};

/**
 * Decode off-thread so AbortSignal timers remain observable. The worker only
 * hosts the shared LZMA1 owner; every verdict is that module's.
 */
const LZMA_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = process.getBuiltinModule("node:worker_threads");
(async () => {
  const lzma = require(workerData.lzmaPath);
  const { decodeLzma1KnownSize } = await import(workerData.lzma1Url);
  const alone = Buffer.from(workerData.alone);
  const result = decodeLzma1KnownSize(
    lzma,
    alone,
    workerData.dictionaryBytes,
    workerData.expected,
  );
  if (result.ok)
    parentPort.postMessage(
      { ok: true, buffer: result.output.buffer, byteLength: result.output.length },
      [result.output.buffer],
    );
  else
    parentPort.postMessage({ ok: false, kind: result.kind, message: result.message });
})();
`;

/**
 * The shared LZMA1 owner, loaded by the worker thread. Development runs load
 * its source (Node strips its types; it imports no repository modules).
 */
const LZMA1_MODULE_URL = new URL(
  import.meta.url.endsWith(".ts") ? "./Lzma1.ts" : "./Lzma1.js",
  import.meta.url,
).href;

type DecodeOutcome =
  | { readonly ok: true; readonly value: Buffer }
  | { readonly ok: false; readonly cause: unknown };

/** The decoder's own verdict about the block, as the worker reported it. */
const replyOutcome = (message: WorkerReply): DecodeOutcome =>
  message.ok
    ? { ok: true, value: Buffer.from(message.buffer, 0, message.byteLength) }
    : {
        ok: false,
        // The format already admitted the declared size, so every verdict,
        // including output that overruns that declaration, is malformed.
        cause: new BinaryFormatFailure("malformed", message.message),
      };

/**
 * The worker reports decoder outcomes as messages. An error event is a
 * runtime failure, not a fact about the block, so only memory exhaustion is
 * translated (into the resource failure it is); anything else stays as Node
 * reported it rather than becoming "malformed".
 */
const workerRuntimeFailure = (
  cause: Error & { readonly code?: unknown },
  expected: number,
): unknown =>
  cause.code === "ERR_WORKER_OUT_OF_MEMORY"
    ? new BinaryResourceFailure(
        "structure",
        expected,
        "Unity LZMA worker exhausted its memory",
      )
    : cause;

const decodeAloneInWorker = async (
  alone: Buffer,
  dictionaryBytes: number,
  expected: number,
  signal?: AbortSignal,
): Promise<Buffer> => {
  await yieldArtifactRead(signal);
  const lzmaPath = createRequire(import.meta.url).resolve("lzma-purejs");
  // allocUnsafeSlow always owns a dedicated ArrayBuffer (not a SharedArrayBuffer).
  const transferable = alone.buffer as ArrayBuffer;
  return await new Promise<Buffer>((resolve, reject) => {
    let finishing = false;
    let exited = false;
    let termination: Promise<number> | undefined;
    const worker = new Worker(LZMA_WORKER_SOURCE, {
      eval: true,
      workerData: {
        lzmaPath,
        lzma1Url: LZMA1_MODULE_URL,
        alone: transferable,
        dictionaryBytes,
        expected,
      },
      transferList: [transferable],
    });
    const terminateWorker = (): Promise<number> => {
      if (exited) return Promise.resolve(0);
      termination ??= worker.terminate();
      return termination;
    };
    const finish = (outcome: DecodeOutcome, waitForExit: boolean): void => {
      if (finishing) return;
      finishing = true;
      signal?.removeEventListener("abort", onAbort);
      const settleNow = (): void => {
        if (outcome.ok) resolve(outcome.value);
        else reject(outcome.cause);
      };
      if (!waitForExit || exited) {
        settleNow();
        return;
      }
      terminateWorker().then(
        () => {
          exited = true;
          settleNow();
        },
        (termCause: unknown) => {
          if (outcome.ok) {
            reject(termCause);
            return;
          }
          reject(
            new AggregateError(
              [outcome.cause, termCause],
              "Unity LZMA decode and worker termination both failed",
              { cause: outcome.cause },
            ),
          );
        },
      );
    };
    const onAbort = (): void => {
      let cause: unknown;
      try {
        assertArtifactReadActive(signal);
        rejectLzma("Unity LZMA worker terminated");
      } catch (caught: unknown) {
        cause = caught;
      }
      finish({ ok: false, cause }, true);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    worker.on("message", (message: WorkerReply) => {
      finish(replyOutcome(message), true);
    });
    worker.on("error", (cause: Error & { readonly code?: unknown }) => {
      finish({ ok: false, cause: workerRuntimeFailure(cause, expected) }, true);
    });
    worker.on("exit", (code: number) => {
      exited = true;
      if (finishing) return;
      let cause: unknown;
      try {
        assertArtifactReadActive(signal);
        throw new Error(
          `Unity LZMA worker exited with code ${String(code)} without returning a result`,
        );
      } catch (caught: unknown) {
        cause = caught;
      }
      finish({ ok: false, cause }, false);
    });
  });
};

/**
 * UnityFS LZMA blocks: five property bytes plus the raw stream, with no size
 * field. The block table's uncompressed length is the declared size; a
 * stream may end there or with an end marker (see `decodeLzma1KnownSize`).
 */
export const decodeUnityLzmaBlock = async (
  input: Buffer,
  expected: number,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> => {
  if (
    !Number.isSafeInteger(expected) ||
    expected < 0 ||
    expected > maximumBytes
  )
    throw new BinaryResourceFailure(
      "structure",
      maximumBytes,
      "LZMA decoded length exceeds the object budget",
    );
  assertArtifactReadActive(signal);
  // UnityFS stores the five properties bytes and the coded stream, with the
  // size in its block table; the shared owner validates the header once here
  // so a malformed block never starts a worker, and again where it decodes.
  const alone = lzma1AloneFromRaw(input, BigInt(expected));
  const header = readLzma1AloneHeader(alone);
  if (!header.ok) return rejectLzma(`Unity LZMA block: ${header.message}`);
  const leadIn = checkLzma1RangeCoderLeadIn(alone);
  if (leadIn !== undefined)
    return rejectLzma(`Unity LZMA block: ${leadIn.message}`);
  return await decodeAloneInWorker(
    alone,
    header.dictionaryBytes,
    expected,
    signal,
  );
};
