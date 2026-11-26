import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import {
  ArtifactReaderFailure,
  assertArtifactReadActive,
  yieldArtifactRead,
} from "../resources/index.js";
import {
  BinaryFormatFailure,
  BinaryReader,
  BinaryResourceFailure,
} from "../domain/binaryContainer.js";

const LZMA_PROPS_BYTES = 5;
const LZMA_ALONE_SIZE_BYTES = 8;
const LZMA_DICTIONARY_OFFSET = 1;
const LZMA_MIN_DICTIONARY_BYTES = 0x1000;
const LZMA_RANGE_CODER_INIT_BYTES = 5;

type WorkerReply =
  | { readonly ok: true; readonly buffer: ArrayBuffer }
  | {
      readonly ok: false;
      readonly kind: "malformed" | "structure";
      readonly message: string;
    };

const rejectLzma = (message: string): never => {
  throw new BinaryFormatFailure("malformed", message);
};

/** Off-thread decompressFile so AbortSignal timers remain observable. */
const LZMA_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = process.getBuiltinModule("node:worker_threads");
const lzma = require(workerData.lzmaPath);
const expected = workerData.expected;
const alone = Buffer.from(workerData.alone);
const UNKNOWN_SIZE = 0xffffffffffffffffn;
const SIZE_OFFSET = 5;

const decode = (sizeField) => {
  alone.writeBigUInt64LE(sizeField, SIZE_OFFSET);
  // Node Buffer pools: allocUnsafe slices cannot be transferred safely.
  const output = Buffer.allocUnsafeSlow(expected);
  let written = 0;
  let position = 0;
  lzma.decompressFile(
    {
      readByte() {
        if (position >= alone.length)
          throw { kind: "malformed", message: "Truncated Unity LZMA stream" };
        return alone[position++];
      },
    },
    {
      writeByte(byte) {
        if (written >= expected)
          throw {
            kind: "structure",
            message: "LZMA decoded length exceeds the object budget",
          };
        output[written++] = byte;
      },
    },
  );
  if (written !== expected)
    throw {
      kind: "malformed",
      message: "LZMA decoded length disagrees with its declaration",
    };
  return { output, position };
};

try {
  let result = decode(BigInt(expected));
  if (result.position !== alone.length) {
    result = decode(UNKNOWN_SIZE);
    if (result.position !== alone.length)
      throw {
        kind: "malformed",
        message: "Unity LZMA stream has trailing bytes",
      };
  }
  parentPort.postMessage({ ok: true, buffer: result.output.buffer }, [
    result.output.buffer,
  ]);
} catch (cause) {
  if (cause && typeof cause === "object" && "kind" in cause && "message" in cause) {
    parentPort.postMessage({
      ok: false,
      kind: cause.kind,
      message: cause.message,
    });
  } else {
    parentPort.postMessage({
      ok: false,
      kind: "malformed",
      message:
        cause instanceof Error
          ? cause.message
          : "Unity LZMA block does not decode",
    });
  }
}
`;

const synthesizeAloneHeader = (
  input: Buffer,
  expected: number,
  dictionaryBytes: number,
): Buffer => {
  // Non-pooled backing ArrayBuffer so it can be transferred to the worker
  // directly without copying the encoded stream a second time.
  const alone = Buffer.allocUnsafeSlow(input.length + LZMA_ALONE_SIZE_BYTES);
  input.copy(alone, 0, 0, LZMA_PROPS_BYTES);
  alone.writeBigUInt64LE(BigInt(expected), LZMA_PROPS_BYTES);
  input.copy(alone, LZMA_PROPS_BYTES + LZMA_ALONE_SIZE_BYTES, LZMA_PROPS_BYTES);
  // lzma-purejs allocates its window from the declared dictionary; EDK II and
  // Unity both promote values below 4 KiB, so normalize the private copy.
  if (dictionaryBytes < LZMA_MIN_DICTIONARY_BYTES)
    alone.writeUInt32LE(LZMA_MIN_DICTIONARY_BYTES, LZMA_DICTIONARY_OFFSET);
  return alone;
};

const decodeAloneInWorker = async (
  alone: Buffer,
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
        alone: transferable,
        expected,
      },
      transferList: [transferable],
    });
    const terminateWorker = (): Promise<number> => {
      if (exited) return Promise.resolve(0);
      termination ??= worker.terminate();
      return termination;
    };
    const finish = (
      outcome:
        | { readonly ok: true; readonly value: Buffer }
        | { readonly ok: false; readonly cause: unknown },
      waitForExit: boolean,
    ): void => {
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
      if (message.ok) {
        finish({ ok: true, value: Buffer.from(message.buffer) }, true);
        return;
      }
      const cause =
        message.kind === "structure"
          ? new BinaryResourceFailure("structure", expected, message.message)
          : new BinaryFormatFailure("malformed", message.message);
      finish({ ok: false, cause }, true);
    });
    worker.on("error", (cause: Error) => {
      finish({ ok: false, cause }, true);
    });
    worker.on("exit", (code: number) => {
      exited = true;
      if (finishing) return;
      let cause: unknown;
      try {
        assertArtifactReadActive(signal);
        if (code !== 0)
          rejectLzma("Unity LZMA worker exited before completing");
        rejectLzma("Unity LZMA worker exited without returning a result");
      } catch (caught: unknown) {
        cause = caught;
      }
      finish({ ok: false, cause }, false);
    });
  });
};

/**
 * UnityFS LZMA blocks: five property bytes plus the raw stream, with no size
 * field. The caller's declared uncompressed length becomes the LZMA-Alone size
 * so lzma-purejs can finish without an end marker; a valid optional end marker
 * is still accepted.
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
  if (input.length < LZMA_PROPS_BYTES + LZMA_RANGE_CODER_INIT_BYTES)
    return rejectLzma("Truncated Unity LZMA block");
  const props = input[0]!;
  const lc = props % 9;
  const remainder = (props / 9) | 0;
  const lp = remainder % 5;
  const pb = (remainder / 5) | 0;
  if (pb > 4 || lc + lp > 4)
    return rejectLzma("Unity LZMA properties are out of range");
  const dictionaryBytes = new BinaryReader(input, true, "Unity LZMA").u32(
    LZMA_DICTIONARY_OFFSET,
  );
  if (dictionaryBytes > maximumBytes)
    throw new BinaryResourceFailure(
      "structure",
      maximumBytes,
      "LZMA dictionary exceeds the object budget",
    );
  // Range coder state starts with a mandatory zero byte after the properties.
  if (input[LZMA_PROPS_BYTES]! !== 0)
    return rejectLzma("Unity LZMA range coder header is invalid");

  const alone = synthesizeAloneHeader(input, expected, dictionaryBytes);
  try {
    return await decodeAloneInWorker(alone, expected, signal);
  } catch (cause: unknown) {
    if (
      cause instanceof ArtifactReaderFailure ||
      cause instanceof BinaryFormatFailure ||
      cause instanceof BinaryResourceFailure
    )
      throw cause;
    throw new BinaryFormatFailure(
      "malformed",
      cause instanceof Error
        ? cause.message
        : "Unity LZMA block does not decode",
    );
  }
};
