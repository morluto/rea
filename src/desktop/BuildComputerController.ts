import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";

import { z } from "zod";

import type { JsonValue } from "../domain/jsonValue.js";
import {
  guestFileAnswerBytes,
  guestFileAnswerCeiling,
  guestFileAnswerWorkingBytes,
  type AgentEnvComputer,
} from "./AgentEnvComputer.js";

const CONTROLLER = fileURLToPath(
  new URL("../../bridge/agentenv/capture.py", import.meta.url),
);
/** The most file bytes one `data/get` brings back, so a large bundle arrives in several answers. */
const FETCH_BATCH_BYTES = 8 * 1024 * 1024;
/**
 * Linux `MAX_ARG_STRLEN` on a 4 KiB page, excluding the NUL the kernel counts.
 * One argument past this fails with E2BIG before the process starts.
 */
export const LINUX_SINGLE_ARGUMENT_BYTES = 32 * 4096 - 1;

let source: Promise<string> | undefined;

const isLowSurrogate = (text: string, index: number): boolean => {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
};

/** Pieces of `text` that each fit in one Linux argument and join back to it. */
export const controllerArgumentPieces = (text: string): readonly string[] => {
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    let low = start + 1;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const bytes = Buffer.byteLength(text.slice(start, mid));
      if (bytes <= LINUX_SINGLE_ARGUMENT_BYTES) low = mid;
      else high = mid - 1;
    }
    let end = low;
    if (end < text.length && isLowSurrogate(text, end)) end -= 1;
    if (end <= start) end = Math.min(text.length, start + 1);
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
};

/** The computer routes REA's build controller uses, and the control token's redaction for what it reads. */
export type ControlledComputer = Pick<
  AgentEnvComputer,
  "exec" | "homeFiles" | "redacted"
>;

/**
 * Run one command of REA's build controller in the computer, as its user and
 * in its home, and return the JSON object it answers with. The controller's
 * source travels with the command, so nothing of it is installed.
 */
export const runBuildController = async (
  computer: ControlledComputer,
  command: "start" | "mark" | "stop" | "run" | "list",
  argumentsJson: Readonly<Record<string, JsonValue>>,
  options: { readonly timeoutS: number; readonly signal?: AbortSignal },
): Promise<Readonly<Record<string, unknown>>> => {
  const { timeoutS, signal } = options;
  source ??= readFile(CONTROLLER, "utf8");
  const script = await source;
  if (Buffer.byteLength(script) > LINUX_SINGLE_ARGUMENT_BYTES)
    throw new Error(
      `REA's build controller source is ${String(Buffer.byteLength(script))} bytes, above the ${String(LINUX_SINGLE_ARGUMENT_BYTES)} bytes Linux passes as one argument.`,
    );
  const result = await computer.exec(
    [
      "python3",
      "-I",
      "-c",
      script,
      command,
      ...controllerArgumentPieces(JSON.stringify(argumentsJson)),
    ],
    // The controller's own waits end first, so it can answer.
    timeoutS + 60,
    signal,
  );
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  try {
    const parsed = z
      .record(z.string(), z.unknown())
      .safeParse(JSON.parse(line));
    if (parsed.success) return parsed.data;
  } catch {
    // Reported below with what the command wrote.
  }
  throw new Error(
    `REA's build controller (${command}) ${result.timed_out ? "timed out" : `exited ${String(result.exit_code)}`} without answering: ${result.stderr.slice(-2048) || result.stdout.slice(-2048)}`,
  );
};

/** What REA's build controller answers a command with. The wire format stays here. */
export const answerSchema = z.looseObject({
  error: z.string().optional(),
  /** Why the controller refused a request before acting on it, such as a state path outside the home. */
  refused: z.string().optional(),
  absent: z.boolean().optional(),
  line: z.string().optional(),
  exited: z.int().optional(),
  timed_out: z.boolean().optional(),
  progress: z.string().optional(),
  output: z.string().optional(),
  exit_code: z.int().nullable().optional(),
  output_bytes: z.int().nonnegative().optional(),
  stdout_bytes: z.int().nonnegative().optional(),
  stderr: z.string().optional(),
  apt: z
    .looseObject({ lists: z.int().nonnegative(), error: z.string().optional() })
    .optional(),
});
export type Answer = z.infer<typeof answerSchema>;

/** One controller command, its answer parsed. */
export const controller = async (
  computer: ControlledComputer,
  command: "start" | "mark" | "stop",
  argumentsJson: Readonly<Record<string, JsonValue>>,
  options: { readonly timeoutS: number; readonly signal: AbortSignal },
): Promise<Answer> =>
  answerSchema.parse(
    await runBuildController(computer, command, argumentsJson, options),
  );

/**
 * Run one `rea` command in the computer with its output in a file under the
 * work folder, after writing the files it reads; the output's size.
 */
export const runRea = async (
  computer: ControlledComputer,
  argv: readonly string[],
  options: {
    readonly work: string;
    readonly stdout: string;
    readonly files?: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  },
): Promise<number> => {
  const answer = answerSchema.parse(
    await runBuildController(
      computer,
      "run",
      {
        work: options.work,
        argv: [...argv],
        stdout: options.stdout,
        files: { ...options.files },
        timeout_s: 1800,
      },
      { timeoutS: 1800, signal: options.signal },
    ),
  );
  if (answer.exit_code === undefined || answer.stdout_bytes === undefined)
    throw new Error(
      answer.error ?? `rea ${argv[0] ?? ""} did not finish in the computer.`,
    );
  return answer.stdout_bytes;
};

const listedSchema = z.object({ listing_bytes: z.int().nonnegative() });
const listingSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().min(1),
      size: z.int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    }),
  ),
  skipped: z.array(z.string()),
});

/** One file brought back from the computer, by its path under the fetched folder. */
export interface FetchedFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}

/**
 * Every regular file under a home folder with its size and digest, and what
 * else the folder holds. The controller writes the list to a file beside the
 * folder and REA reads it through `data/get`, within the size it answers, as
 * it reads REA's own outputs: a large bundle's list outgrows the 1 MiB a
 * command's output is cut at.
 */
const listFolder = async (
  computer: ControlledComputer,
  folder: string,
  signal: AbortSignal | undefined,
): Promise<z.infer<typeof listingSchema>> => {
  const output = `${folder}.listing.json`;
  const { listing_bytes: bytes } = listedSchema.parse(
    await runBuildController(
      computer,
      "list",
      { root: folder, output },
      { timeoutS: 300, ...(signal === undefined ? {} : { signal }) },
    ),
  );
  const content = (await computer.homeFiles([output], bytes, signal)).get(
    output,
  );
  if (content === undefined) throw new Error(`The computer has no ${output}.`);
  return listingSchema.parse(JSON.parse(content.toString("utf8")));
};

/** One listed file and the answer budget a batch must fit. */
export interface ListedBatchFile {
  readonly path: string;
  readonly size: number;
}

/**
 * Files fetched together. A batch stops before its raw bytes pass
 * `rawBytes` or its base64 answer, including each file's envelope, passes
 * `answerBytes`.
 */
export const batchListedFiles = <File extends ListedBatchFile>(
  files: readonly File[],
  limits: { readonly rawBytes: number; readonly answerBytes: number },
): { files: File[]; bytes: number }[] => {
  const batches: { files: File[]; bytes: number }[] = [];
  for (const file of files) {
    const last = batches.at(-1);
    const nextBytes = (last?.bytes ?? 0) + file.size;
    const nextCount = (last?.files.length ?? 0) + 1;
    const fits =
      last !== undefined &&
      nextBytes <= limits.rawBytes &&
      guestFileAnswerBytes(nextBytes, nextCount) <= limits.answerBytes;
    if (last === undefined || !fits)
      batches.push({ files: [file], bytes: file.size });
    else {
      last.files.push(file);
      last.bytes = nextBytes;
    }
  }
  return batches;
};

/** The answers for one home folder: files listed, then fetched in batches of about `FETCH_BATCH_BYTES` that also fit the host answer budget. */
const batched = (files: z.infer<typeof listingSchema>["files"]) =>
  batchListedFiles(files, {
    rawBytes: FETCH_BATCH_BYTES,
    answerBytes: guestFileAnswerWorkingBytes(guestFileAnswerCeiling()),
  });

/**
 * Bring every regular file under a home folder of the computer back to REA:
 * listed with sizes and digests in the computer, fetched through `data/get`
 * in answers of at most 8 MiB of files each (a larger file comes alone),
 * each checked against its listing and handed to `sink` before the next
 * answer is asked for, so one answer at a time is held. A link or special
 * file is refused. The value counts the files and bytes handed over.
 */
export const fetchHomeFolder = async (
  computer: ControlledComputer,
  folder: string,
  sink: { readonly file: (file: FetchedFile) => Promise<void> },
  signal?: AbortSignal,
): Promise<{ readonly files: number; readonly bytes: number }> => {
  const listing = await listFolder(computer, folder, signal);
  if (listing.skipped.length > 0)
    throw new Error(
      `${folder} holds entries other than regular files: ${listing.skipped.join(", ")}.`,
    );
  let handed = { files: 0, bytes: 0 };
  for (const { files: batch, bytes } of batched(listing.files)) {
    const files = await computer.homeFiles(
      batch.map((file) => file.path),
      bytes,
      signal,
    );
    for (const file of batch) {
      const content = files.get(file.path);
      const sha256 =
        content === undefined
          ? undefined
          : createHash("sha256").update(content).digest("hex");
      if (
        !file.path.startsWith(`${folder}/`) ||
        content?.length !== file.size ||
        sha256 !== file.sha256
      )
        throw new Error(
          `${file.path} is missing from the computer's answer or differs from its listing.`,
        );
      await sink.file({
        path: file.path.slice(folder.length + 1),
        bytes: content,
        sha256,
      });
      handed = { files: handed.files + 1, bytes: handed.bytes + file.size };
    }
  }
  return handed;
};
