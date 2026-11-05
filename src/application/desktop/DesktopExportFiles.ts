import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import type { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import type {
  DesktopAppExportPlan,
  SeedScrubReport,
} from "../../domain/desktop/appExport.js";
import {
  hostIdentityIn,
  scrubSeed,
  type HostIdentity,
} from "../../domain/desktop/hostIdentity.js";
import { refuse } from "./DesktopExportInstall.js";
import type { RetainedContent } from "./DesktopRetainedContent.js";

/** A file the export writes from bytes it made. */
export interface GeneratedFile {
  readonly path: string;
  readonly bytes: Buffer;
}

/** A bundle file copied from retained content: a seed, with its home path and whether it is read as text, or an apt key. */
export interface RetainedCopy {
  readonly path: string;
  readonly digest: string;
  readonly name: string;
  readonly seed?: { readonly home: string; readonly text: boolean };
}

/** The files a bundle holds; the README is made last, from what the seeds' scrub found. */
export interface ExportBundle {
  readonly generated: readonly GeneratedFile[];
  readonly copies: readonly RetainedCopy[];
  readonly identity: HostIdentity;
  readonly readme: (scrub: SeedScrubReport) => GeneratedFile;
}

/** Each seed by its home path, then each distinct apt key in the environment folder. */
export const retainedCopies = (
  plan: DesktopAppExportPlan,
  seeds: ReadonlyMap<string, string>,
): readonly RetainedCopy[] => {
  const text = new Set(plan.textSeeds);
  return [
    ...[...seeds].map(([seed, digest]) => ({
      path: `envs/${plan.name}/seed/${seed}`,
      digest,
      name: `~/${seed}`,
      seed: { home: seed, text: text.has(seed) },
    })),
    ...[
      ...new Map(
        plan.aptSources.map((source) => [source.keyFile, source.keySha256]),
      ),
    ].map(([keyFile, digest]) => ({
      path: `envs/${plan.name}/${keyFile}`,
      digest,
      name: `the apt key ${keyFile}`,
    })),
  ];
};

/**
 * Write the generated files, then each retained file as it is read, so one at
 * a time is in memory: a seed whose text names the capture host becomes a
 * generated file with its own digest. The README follows, listing them.
 */
export const writeFiles = async (
  tree: SafeOutputTree,
  content: RetainedContent,
  bundle: ExportBundle,
  signal: AbortSignal | undefined,
): Promise<SeedScrubReport> => {
  const write = (path: string, bytes: Buffer, sha256?: string) =>
    tree.write(
      path,
      Readable.from([bytes]),
      {
        bytes: bytes.length,
        sha256: sha256 ?? createHash("sha256").update(bytes).digest("hex"),
      },
      signal,
    );
  for (const file of bundle.generated) await write(file.path, file.bytes);
  const scrubbed: string[] = [];
  const unscrubbed: string[] = [];
  for (const copy of bundle.copies) {
    signal?.throwIfAborted();
    const bytes = await content.read(copy.digest, signal);
    if (!bytes.ok)
      throw refuse(
        `The retained content of ${copy.name} ${bytes.error}.`,
        "capture",
        "Capture the application again, leaving a seed file out of its state paths if it cannot be retained.",
      );
    const seed = copy.seed;
    const scrub =
      seed === undefined
        ? undefined
        : scrubSeed(bytes.value, seed.text, bundle.identity);
    if (seed !== undefined && scrub?.bytes !== undefined)
      scrubbed.push(seed.home);
    if (
      seed !== undefined &&
      (scrub?.holdsIdentity === true ||
        hostIdentityIn(seed.home, bundle.identity) !== undefined)
    )
      unscrubbed.push(seed.home);
    if (scrub?.bytes === undefined)
      await write(copy.path, bytes.value, copy.digest);
    else await write(copy.path, scrub.bytes);
  }
  const report = { scrubbed, unscrubbed };
  const readme = bundle.readme(report);
  await write(readme.path, readme.bytes);
  return report;
};
