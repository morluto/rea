import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import type { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import type {
  DesktopAppExportPlan,
  SeedScrubReport,
} from "../../domain/desktop/appExport.js";
import type { TaskFileView } from "../../domain/desktop/appTaskChecks.js";
import {
  compressionOf,
  openStateDocument,
} from "../../domain/desktop/gzipDocument.js";
import {
  identityLeftIn,
  type HostIdentity,
} from "../../domain/desktop/hostIdentity.js";
import { withoutRecoveryList } from "../../domain/desktop/seedRecoveryList.js";
import { scrubSeed } from "../../domain/desktop/seedScrub.js";
import {
  isTextualFormat,
  textualView,
} from "../../domain/desktop/stateFormats.js";
import { err } from "../../domain/result.js";
import { refuse } from "./DesktopExportInstall.js";
import type { RetainedContent } from "./DesktopRetainedContent.js";

/** A file the export writes from bytes it made. */
export interface GeneratedFile {
  readonly path: string;
  readonly bytes: Buffer;
  /** Whether what it was made from holds the identity in a spelling its bytes do not show, such as a decoded escape. */
  readonly holdsIdentity?: boolean;
}

/** A seed file's retained digest and the format the state view read it as. */
export interface SeedVersion {
  readonly sha256: string;
  readonly format: string | null;
}

/** A bundle file copied from retained content: a seed, with its home path and format, or an apt key. */
export interface RetainedCopy {
  readonly path: string;
  readonly digest: string;
  readonly name: string;
  readonly seed?: { readonly home: string; readonly format: string | null };
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
  seeds: ReadonlyMap<string, SeedVersion>,
): readonly RetainedCopy[] => [
  ...[...seeds].map(([seed, { sha256, format }]) => ({
    path: `envs/${plan.name}/seed/${seed}`,
    digest: sha256,
    name: `~/${seed}`,
    seed: { home: seed, format },
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

/** A retained file's bytes, refused when they cannot be read. */
const retainedBytes = async (
  content: RetainedContent,
  copy: RetainedCopy,
  signal: AbortSignal | undefined,
): Promise<Buffer> => {
  signal?.throwIfAborted();
  const bytes = await content.read(copy.digest, signal);
  if (!bytes.ok)
    throw refuse(
      `The retained content of ${copy.name} ${bytes.error}.`,
      "capture",
      "Capture the application again, leaving a seed file out of its state paths if it cannot be retained.",
    );
  return bytes.value;
};

/**
 * A seed as it ships: LibreOffice's recovery list left out, then the
 * identity scrubbed, a gzip seed's inside its document. LibreOffice writes
 * its registry uncompressed, so a gzip seed holds no recovery list to drop.
 */
const shippedSeed = (
  bytes: Buffer,
  seed: NonNullable<RetainedCopy["seed"]>,
  identity: HostIdentity,
) => {
  const recovered = withoutRecoveryList(seed.home, bytes);
  const scrub = scrubSeed(recovered ?? bytes, seed, identity);
  return {
    bytes: scrub.bytes ?? recovered,
    holdsIdentity: scrub.holdsIdentity,
    scrubbed: scrub.bytes !== undefined && scrub.recompressed !== true,
    recompressed: scrub.recompressed === true,
    recovered: recovered !== undefined,
  };
};

/**
 * The view of each rewritten text seed, including a formerly unreadable gzip
 * seed, as the bundle ships it: the computer starts from these bytes.
 */
export const shippedSeedViews = async (
  content: RetainedContent,
  copies: readonly RetainedCopy[],
  identity: HostIdentity,
  signal: AbortSignal | undefined,
): Promise<ReadonlyMap<string, TaskFileView>> => {
  const views = new Map<string, TaskFileView>();
  for (const copy of copies) {
    const seed = copy.seed;
    if (
      seed === undefined ||
      (seed.format !== null && !isTextualFormat(seed.format))
    )
      continue;
    const bytes = await retainedBytes(content, copy, signal);
    const shipped = shippedSeed(bytes, seed, identity).bytes;
    if (shipped === undefined) continue;
    const document = openStateDocument(seed.home, shipped);
    const { format } = document;
    const view =
      "error" in document
        ? err(document.error)
        : isTextualFormat(format)
          ? textualView(format, document.bytes)
          : undefined;
    views.set(seed.home, {
      format,
      ...compressionOf(document),
      ...(view === undefined || view.ok
        ? { view: view?.value ?? null }
        : { view: null, error: view.error }),
    });
  }
  return views;
};

/**
 * Write the generated files, then each retained file as it is read, so one at
 * a time is in memory: a seed whose text names the capture host, or that
 * holds LibreOffice's recovery list, becomes a generated file with its own
 * digest, and a gzip seed whose document did not change is listed apart as
 * recompressed. The README follows, listing them. Every file is listed as
 * unscrubbed whose path or content still holds the identity.
 */
export const writeFiles = async (
  tree: SafeOutputTree,
  content: RetainedContent,
  bundle: ExportBundle,
  signal: AbortSignal | undefined,
): Promise<SeedScrubReport> => {
  const scrubbed: string[] = [];
  const recompressed: string[] = [];
  const unscrubbed: string[] = [];
  const recovered: string[] = [];
  const write = async (
    path: string,
    bytes: Buffer,
    shipped: { readonly sha256?: string; readonly holdsIdentity: boolean },
  ) => {
    await tree.write(
      path,
      Readable.from([bytes]),
      {
        bytes: bytes.length,
        sha256:
          shipped.sha256 ?? createHash("sha256").update(bytes).digest("hex"),
      },
      signal,
    );
    if (
      shipped.holdsIdentity ||
      identityLeftIn(path, bundle.identity) !== undefined
    )
      unscrubbed.push(path);
  };
  const generated = (file: GeneratedFile) =>
    write(file.path, file.bytes, {
      holdsIdentity:
        file.holdsIdentity === true ||
        identityLeftIn(file.bytes.toString("utf8"), bundle.identity) !==
          undefined,
    });
  for (const file of bundle.generated) await generated(file);
  for (const copy of bundle.copies) {
    const bytes = await retainedBytes(content, copy, signal);
    const shipped =
      copy.seed === undefined
        ? undefined
        : shippedSeed(bytes, copy.seed, bundle.identity);
    const holdsIdentity = shipped?.holdsIdentity === true;
    if (shipped?.recovered === true) recovered.push(copy.name);
    if (shipped?.bytes === undefined)
      await write(copy.path, bytes, { sha256: copy.digest, holdsIdentity });
    else {
      if (shipped.scrubbed) scrubbed.push(copy.path);
      else if (shipped.recompressed) recompressed.push(copy.path);
      await write(copy.path, shipped.bytes, { holdsIdentity });
    }
  }
  await generated(
    bundle.readme({
      scrubbed,
      recompressed,
      unscrubbed: [...unscrubbed],
      recovered,
    }),
  );
  return { scrubbed, recompressed, unscrubbed, recovered };
};
