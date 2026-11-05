import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import type { JsonValue } from "../domain/jsonValue.js";
import type { AgentEnvComputer } from "./AgentEnvComputer.js";

const CONTROLLER = fileURLToPath(
  new URL("../../bridge/agentenv/capture.py", import.meta.url),
);
/** The most file bytes one `data/get` brings back, so a large bundle arrives in several answers. */
const FETCH_BATCH_BYTES = 8 * 1024 * 1024;

let source: Promise<string> | undefined;

/** The computer routes REA's build controller uses. */
export type ControlledComputer = Pick<AgentEnvComputer, "exec" | "homeFiles">;

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
  const result = await computer.exec(
    [
      "python3",
      "-I",
      "-c",
      await source,
      command,
      JSON.stringify(argumentsJson),
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
 * Bring every regular file under a home folder of the computer back to REA:
 * listed with sizes and digests in the computer, fetched through `data/get`
 * in answers of at most 8 MiB of files each (a larger file comes alone), and
 * each checked against its listing. A link or special file is refused.
 */
export const fetchHomeFolder = async (
  computer: ControlledComputer,
  folder: string,
  signal?: AbortSignal,
): Promise<readonly FetchedFile[]> => {
  const listing = listingSchema.parse(
    await runBuildController(
      computer,
      "list",
      { root: folder },
      { timeoutS: 300, ...(signal === undefined ? {} : { signal }) },
    ),
  );
  if (listing.skipped.length > 0)
    throw new Error(
      `${folder} holds entries other than regular files: ${listing.skipped.join(", ")}.`,
    );
  const batches: { files: typeof listing.files; bytes: number }[] = [];
  for (const file of listing.files) {
    const last = batches.at(-1);
    if (last === undefined || last.bytes + file.size > FETCH_BATCH_BYTES)
      batches.push({ files: [file], bytes: file.size });
    else {
      last.files.push(file);
      last.bytes += file.size;
    }
  }
  const fetched: FetchedFile[] = [];
  for (const { files: batch, bytes } of batches) {
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
      fetched.push({
        path: file.path.slice(folder.length + 1),
        bytes: content,
        sha256,
      });
    }
  }
  return fetched;
};
