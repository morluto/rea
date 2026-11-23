import { open } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";

import { encodeLines } from "@toon-format/toon";

import {
  AnalysisCancelledError,
  cancelledBy,
} from "../domain/analysisErrorCore.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { CommandCancellationScope } from "./commandCancellation.js";
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

// Only this output owner can attest a process disposition for a cancellation.
// The shared factory remains the sole constructor of the domain error.
const cancellationStatuses = new WeakMap<
  AnalysisCancelledError,
  130 | 143 | 149
>();

/** Read the output owner's disposition without inferring it from ambient state. */
export const toonOutputCancellationStatus = (
  cause: unknown,
): 130 | 143 | 149 | undefined => {
  const failure =
    cause instanceof ToonOutputCleanupFailure
      ? cause.outputFailure?.cause
      : cause;
  return failure instanceof AnalysisCancelledError
    ? cancellationStatuses.get(failure)
    : undefined;
};

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
    const cancellation = new CommandCancellationScope();
    let retained = false;
    const cancelled = () => {
      const status = cancellation.exitStatus;
      if (status === undefined) return undefined;
      const failure = cancelledBy(operation, cancellation.signal);
      cancellationStatuses.set(failure, status);
      return failure;
    };
    const checkCancellation = () => {
      const failure = cancelled();
      if (failure !== undefined) throw failure;
    };
    try {
      const root = await PrivateRuntimeRoot.create({ prefix: "rea-toon-" });
      const directory = root.path;
      const path = join(directory, "output");
      const resources = new ArtifactResourceScope();
      let owner: OwnedFileHandle | undefined;
      const lease = new AnalysisCleanupLease(
        async () => {
          await owner?.close();
          owner = undefined;
          await root.close();
          cancellation.close();
        },
        {
          get cleanupResources() {
            return owner === undefined ? [directory] : [path, directory];
          },
        },
      );
      let failure: { cause: unknown } | undefined;
      try {
        checkCancellation();
        owner = new OwnedFileHandle(await open(path, "wx+", 0o600));
        const file = owner.handle;
        const stage = async (part: string) => {
          checkCancellation();
          await file.writeFile(part);
          checkCancellation();
        };
        for (const part of buffered) await stage(part);
        await stage(firstStagedPart);
        for (const part of parts) await stage(part);

        checkCancellation();
        beginOutput();
        // Early iterator return must not invalidate the descriptor behind its
        // owner. The lease closes the handle after pending reads settle.
        const chunks: AsyncIterable<string> = file
          .createReadStream({
            start: 0,
            autoClose: false,
            encoding: "utf8",
          })
          .iterator({ destroyOnReturn: false });
        for await (const chunk of chunks) {
          checkCancellation();
          await writeOutputText(destination, chunk);
          checkCancellation();
        }
      } catch (cause: unknown) {
        failure = { cause };
      }
      const cleanup = await resources.release({
        kind: "lease",
        resource: directory,
        lease,
      });
      // An interrupt during the last close/removal is still this operation's.
      const lateCancellation = cancelled();
      if (failure === undefined && lateCancellation !== undefined)
        failure = { cause: lateCancellation };
      if (cleanup.kind === "failed") {
        retainedStages.add(resources);
        retained = true;
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
      cancellation.finish();
      if (!retained) cancellation.close();
    }
  } finally {
    parts.return(undefined);
  }
};
