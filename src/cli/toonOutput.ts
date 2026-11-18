import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";

import { encodeLines } from "@toon-format/toon";

import { bufferedJsonParts } from "../domain/jsonSerialization.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  AnalysisCleanupLease,
  AnalysisCleanupLeaseGroup,
  ArtifactResourceScope,
} from "../resources/index.js";
import { ownCliProcessResource } from "./cliResources.js";
import { formatCliOutput } from "./cliOutputFormatter.js";
import { writeOutputParts, writeOutputText } from "./jsonOutput.js";

const retainedStages = new Set<ArtifactResourceScope>();
ownCliProcessResource("toon-output", async () => {
  const failures: unknown[] = [];
  for (const resources of retainedStages) {
    try {
      await resources.close();
      retainedStages.delete(resources);
    } catch (cause: unknown) {
      failures.push(cause);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "TOON staging cleanup failed");
});

/** The stage owns both its original output failure and retryable cleanup. */
export class ToonOutputCleanupFailure extends ProviderCleanupError {
  constructor(
    readonly outputFailure: { readonly cause: unknown } | undefined,
    operation: string,
    resources: readonly string[],
    cleanupCause: unknown,
  ) {
    super(
      "cli-toon-output",
      resources,
      {
        reason:
          cleanupCause instanceof Error
            ? cleanupCause.message
            : "Stage cleanup failed",
      },
      {
        operation,
        cause: new AggregateError(
          [
            ...(outputFailure === undefined ? [] : [outputFailure.cause]),
            cleanupCause,
          ],
          "TOON output and cleanup failures",
        ),
      },
    );
  }
}

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
  operation: string,
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
    const path = join(directory, "output");
    const resources = new ArtifactResourceScope();
    let owner: OwnedFileHandle | undefined;
    const lease = new AnalysisCleanupLease(
      async () => {
        await owner?.close();
        owner = undefined;
        await rm(directory, { recursive: true, force: true });
      },
      {
        get cleanupResources() {
          return owner === undefined ? [directory] : [path, directory];
        },
      },
    );
    let failure: { cause: unknown } | undefined;
    try {
      owner = new OwnedFileHandle(await open(path, "wx+", 0o600));
      const file = owner.handle;
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
    } catch (cause: unknown) {
      failure = { cause };
    }
    const cleanup = await resources.release({
      kind: "lease",
      resource: directory,
      lease,
    });
    if (cleanup.kind === "failed") {
      retainedStages.add(resources);
      const error = new ToonOutputCleanupFailure(
        failure,
        operation,
        lease.cleanupResources ?? [directory],
        cleanup.cause,
      );
      new AnalysisCleanupLeaseGroup(error, [lease]);
      throw error;
    }
    if (failure !== undefined) throw failure.cause;
  } finally {
    parts.return(undefined);
  }
};
