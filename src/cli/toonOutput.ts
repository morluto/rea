import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";

import { encodeLines } from "@toon-format/toon";

import { bufferedJsonParts } from "../domain/jsonSerialization.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { withOwnedFileHandle } from "../filesystem/OwnedRegularFile.js";
import { formatCliOutput } from "./cliOutputFormatter.js";
import { writeOutputParts, writeOutputText } from "./jsonOutput.js";

function* toonParts(value: object): Generator<string> {
  for (const line of encodeLines(value)) {
    yield line;
    yield "\n";
  }
}

/**
 * Complete encoding before releasing stdout. Keep a small document in memory
 * and stage a larger one privately so a late encoding failure publishes no
 * prefix. The same encoded bytes are read back without visiting the input again.
 */
export const writeToonOutput = async (
  value: unknown,
  destination: Writable,
  beginOutput: () => void,
): Promise<void> => {
  if (typeof value !== "object" || value === null) {
    const text = `${formatCliOutput(value, "toon")}\n`;
    beginOutput();
    await writeOutputText(destination, text);
    return;
  }

  const parts = bufferedJsonParts(toonParts(value));
  try {
    const buffered: string[] = [];
    let characters = 0;
    let next = parts.next();
    while (!next.done && characters + next.value.length <= 1024 * 1024) {
      buffered.push(next.value);
      characters += next.value.length;
      next = parts.next();
    }
    if (next.done) {
      beginOutput();
      await writeOutputParts(
        destination,
        buffered.length === 0 ? ["\n"] : buffered,
      );
      return;
    }
    const firstStagedPart = next.value;
    const directory = await mkdtemp(join(tmpdir(), "rea-toon-"));
    let failure: { cause: unknown } | undefined;
    try {
      const path = join(directory, "output");
      const owner = new OwnedFileHandle(await open(path, "wx+", 0o600));
      await withOwnedFileHandle(path, owner, {}, async (file) => {
        for (const part of buffered) await file.writeFile(part);
        await file.writeFile(firstStagedPart);
        for (const part of parts) await file.writeFile(part);

        beginOutput();
        const chunks: AsyncIterable<string> = file.createReadStream({
          start: 0,
          autoClose: false,
          encoding: "utf8",
        });
        for await (const chunk of chunks)
          await writeOutputText(destination, chunk);
      });
    } catch (cause: unknown) {
      failure = { cause };
      throw cause;
    } finally {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (cleanupCause: unknown) {
        if (failure === undefined) throw cleanupCause;
        throw new AggregateError(
          [failure.cause, cleanupCause],
          "TOON output and temporary directory cleanup failed.",
        );
      }
    }
  } finally {
    parts.return(undefined);
  }
};
