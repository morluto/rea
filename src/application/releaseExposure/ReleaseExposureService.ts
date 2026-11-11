import { basename, dirname, posix, win32 } from "node:path";

import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { appendCallerPath } from "../../filesystem/callerPath.js";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { DesktopApplicationService } from "../artifacts/DesktopApplicationService.js";
import type { ElectronFuseService } from "../electron/ElectronFuseService.js";
import type { GoBinaryService } from "../go/GoBinaryService.js";
import type { RustBinaryService } from "../rust/RustBinaryService.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
  AnalysisUnsupportedTargetError,
} from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { desktopApplicationSchema } from "../../domain/desktopApplication.js";
import { desktopPathConventions } from "../../domain/nativeConvention.js";
import {
  electronFuseReportSchema,
  type ElectronFuseReport,
} from "../../domain/electron/electronFuses.js";
import {
  createEvidence,
  evidenceSchema,
  type Evidence,
} from "../../domain/evidence.js";
import { evidenceSubjectFormatSchema } from "../../domain/evidenceSubject.js";
import { goBinarySchema } from "../../domain/go/goBinary.js";
import { RELEASE_EXPOSURE_PROVIDER } from "../../domain/investigationProviders.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import {
  scanCredentialMarkers,
  type CredentialMarkerHit,
} from "../../domain/releaseExposureCredentialMarkers.js";
import {
  assembleReleaseExposureReport,
  auditReleaseExposureInputSchema,
  MAX_RELEASE_EXPOSURE_NATIVE_IMAGES,
  nativeImagesMayBeUnread,
  RELEASE_EXPOSURE_FUSE_SUBJECTS,
  RELEASE_EXPOSURE_OPERATION,
  type FuseImageFact,
  type MetadataImageFact,
  type ReleaseExposureFuseCandidate,
  type ReleaseExposureNativeImage,
  type ReleaseExposureOwnerFacts,
  type ReleaseExposureScan,
} from "../../domain/releaseExposure.js";
import { err, ok, type Result } from "../../domain/result.js";
import { goBuildPaths } from "../../domain/releaseExposureGoPaths.js";
import { rustBinarySchema } from "../../domain/rust/rustBinary.js";
import type { ReleaseExposurePort } from "./ReleaseExposurePort.js";

export interface ReleaseExposureOwners {
  readonly reader: ReleaseExposurePort;
  readonly electronFuses: Pick<ElectronFuseService, "inspect" | "close">;
  readonly desktop: Pick<DesktopApplicationService, "inspect" | "close">;
  readonly goBinaries: Pick<GoBinaryService, "inspect" | "close">;
  readonly rustBinaries: Pick<RustBinaryService, "inspect" | "close">;
}

/** Compose existing owners into one read-only release-exposure report. */
export class ReleaseExposureService {
  constructor(private readonly owners: ReleaseExposureOwners) {}

  async close(): Promise<void> {
    const owners = [
      ["reader", () => this.owners.reader.close()],
      ["electron fuses", () => this.owners.electronFuses.close()],
      ["desktop", () => this.owners.desktop.close()],
      ["go binaries", () => this.owners.goBinaries.close()],
      ["rust binaries", () => this.owners.rustBinaries.close()],
    ] as const;
    const settled = await Promise.allSettled(
      owners.map(([, close]) => close()),
    );
    const failures = settled.flatMap((result, index) => {
      const owner = owners[index];
      if (result.status !== "rejected" || owner === undefined) return [];
      return [{ owner: owner[0], cause: result.reason }];
    });
    if (failures.length > 0) throw ownerCloseFailure(failures);
  }

  /** Audit one selected artifact. One owner failure stays on that check. */
  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    const input = parseAnalysisInput(
      RELEASE_EXPOSURE_OPERATION,
      rawInput,
      auditReleaseExposureInputSchema,
      options?.signal,
    );
    if (!input.ok) return input;
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(RELEASE_EXPOSURE_OPERATION, {
          cause: options.signal.reason,
        }),
      );
    const markerHits: CredentialMarkerHit[] = [];
    let omittedMarkerHits = 0;
    const interrupted: { scan?: ReleaseExposureScan } = {};
    const scanned = await this.owners.reader.inspect(
      input.value,
      options,
      (text, location) => {
        const markers = scanCredentialMarkers(text, location);
        markerHits.push(...markers.hits);
        omittedMarkerHits += markers.omitted_hits;
      },
      (scan) => {
        interrupted.scan = scan;
      },
    );
    if (!scanned.ok && interrupted.scan === undefined) return scanned;
    const scan = scanned.ok ? scanned.value : interrupted.scan;
    if (scan === undefined)
      throw new Error("Release exposure scan produced no result.");
    const owned = await this.#owners(
      scan,
      options,
      scanned.ok ? undefined : scanned.error,
    );
    let report;
    try {
      report = assembleReleaseExposureReport(owned.scan, {
        ...owned.facts,
        credential_markers: {
          hits: markerHits,
          omitted_hits: omittedMarkerHits,
        },
      });
    } catch (cause) {
      return err(
        owned.stopped ??
          new AnalysisOutputError(
            RELEASE_EXPOSURE_OPERATION,
            "Release exposure report did not match its schema.",
            { cause },
          ),
      );
    }
    const format = evidenceSubjectFormatSchema.safeParse(scan.subject.format);
    const evidence = createEvidence(
      {
        path: scan.subject.path,
        sha256: scan.subject.sha256,
        format: format.success ? format.data : "file",
      },
      RELEASE_EXPOSURE_PROVIDER,
      {
        operation: RELEASE_EXPOSURE_OPERATION,
        parameters: {
          path: input.value.path,
          max_file_bytes: input.value.max_file_bytes,
        },
        result: report,
        confidence: "observed",
        authority: "shipped-artifact",
        limitations: report.limitations,
        locations: [
          {
            kind: "artifact-path",
            path: scan.target.selected_path,
          },
        ],
      },
    );
    if (owned.stopped !== undefined)
      return err(withAuditPartial(owned.stopped, evidence));
    return completeProviderEvidence(evidence, options?.signal);
  }

  /**
   * Run each owner in order. After cancellation or unfinished cleanup the
   * remaining owners do not run, and their facts stay failed so those checks
   * report unknown. An owner that stops the audit after completing its
   * Evidence still settles its own fact from that Evidence.
   */
  async #owners(
    scan: ReleaseExposureScan,
    options: ExecutionOptions | undefined,
    interrupted?: AnalysisError,
  ): Promise<OwnerOutcome> {
    const stopped: { error?: AnalysisError } = {};
    if (interrupted !== undefined) stopped.error = interrupted;
    const settle = async <Fact>(
      read: () => Promise<Result<Fact, AnalysisError>>,
      notRun: Fact,
      present: (value: Evidence) => Fact,
    ): Promise<Fact> => {
      if (stopped.error !== undefined) return notRun;
      const result = await read();
      if (result.ok) return result.value;
      stopped.error = result.error;
      const completed = completedOwnerEvidence(result.error);
      return completed === undefined ? notRun : present(completed);
    };
    const desktop = await settle(
      () => this.#desktopFamily(scan, options),
      { family: "unknown", reason: OWNER_NOT_RUN, archivePaths: [] },
      (value) =>
        desktopFamily(value, scan.target.kind, scan.target.selected_path),
    );
    const prepared = limitNativeSample(
      scan,
      desktop.archivePaths,
      desktop.family === "unknown",
    );
    const digests = new Map(
      scan.native_images.flatMap((image) =>
        image.sha256 === undefined ? [] : [[image.path, image.sha256] as const],
      ),
    );
    const fuseImages: FuseImageFact[] = [];
    for (const candidate of prepared.scan.fuse_candidates) {
      if (bundleReadCovers(candidate, digests, fuseImages)) continue;
      fuseImages.push(
        await settle(
          () => this.#fuseImage(candidate, digests, options),
          {
            kind: "failed",
            role: candidate.role,
            path: candidate.path,
            reason: OWNER_NOT_RUN,
          },
          (value) => fuseImageFact(candidate, digests, value),
        ),
      );
    }
    const family = fuseImagesRuleOutElectron(
      desktop.family,
      prepared.scan,
      fuseImages,
    )
      ? ({ family: "not_electron", reason: null } as const)
      : desktop;
    const goImages: MetadataImageFact[] = [];
    const rustImages: MetadataImageFact[] = [];
    for (const image of prepared.scan.native_images) {
      const notRun = failedMetadata(OWNER_NOT_RUN, image.path);
      goImages.push(
        await settle(
          () => this.#goImage(image, options),
          notRun,
          (value) => ({
            ...goMetadata(image)(value),
            path: image.path,
          }),
        ),
      );
      rustImages.push(
        await settle(
          () => this.#rustImage(image, options),
          notRun,
          (value) => ({ ...rustMetadata(image)(value), path: image.path }),
        ),
      );
    }
    return {
      scan:
        stopped.error === undefined
          ? prepared.scan
          : {
              ...prepared.scan,
              limitations: [...prepared.scan.limitations, OWNER_NOT_RUN],
            },
      facts: {
        electron_family: family.family,
        electron_family_reason: family.reason,
        electron_executable_included: prepared.electronExecutableIncluded,
        electron_host_paths: prepared.electronHostPaths,
        ...(family.family === "electron" && desktop.layoutsComplete === false
          ? { electron_layouts_complete: false }
          : {}),
        fuse_images: fuseImages,
        go_images: goImages,
        rust_images: rustImages,
      },
      stopped: stopped.error,
    };
  }

  async #desktopFamily(
    scan: ReleaseExposureScan,
    options: ExecutionOptions | undefined,
  ): Promise<Result<DesktopFamilyFact, AnalysisError>> {
    if (scan.target.kind === "asar")
      return ok({
        family: "unknown",
        reason:
          "A selected ASAR does not include the Electron executable that holds the fuses. Select the application instead.",
        archivePaths: [],
      });
    if (scan.target.kind !== "app" && scan.target.kind !== "directory")
      return ok({ family: "not_a_directory", reason: null, archivePaths: [] });
    try {
      const result = await this.owners.desktop.inspect(
        { path: scan.target.selected_path },
        options,
      );
      if (!result.ok) {
        if (stopsAudit(result.error)) return err(result.error);
        return ok({
          family: "unknown",
          reason: result.error.message,
          archivePaths: [],
        });
      }
      return ok(
        desktopFamily(
          result.value,
          scan.target.kind,
          scan.target.selected_path,
        ),
      );
    } catch (cause) {
      if (cause instanceof AnalysisError && stopsAudit(cause))
        return err(cause);
      return ok({
        family: "unknown",
        reason: cause instanceof Error ? cause.message : String(cause),
        archivePaths: [],
      });
    }
  }

  async #fuseImage(
    candidate: ReleaseExposureFuseCandidate,
    digests: ReadonlyMap<string, string>,
    options: ExecutionOptions | undefined,
  ): Promise<Result<FuseImageFact, AnalysisError>> {
    let result: Result<Evidence, AnalysisError>;
    try {
      result = await this.owners.electronFuses.inspect(
        { path: candidate.path },
        options,
      );
    } catch (cause) {
      if (cause instanceof AnalysisError && stopsAudit(cause))
        return err(cause);
      return ok({
        kind: "failed",
        role: candidate.role,
        path: candidate.path,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (!result.ok) {
      if (stopsAudit(result.error)) return err(result.error);
      if (result.error instanceof AnalysisUnsupportedTargetError)
        return ok({
          kind: "unsupported",
          role: candidate.role,
          path: candidate.path,
        });
      return ok({
        kind: "failed",
        role: candidate.role,
        path: candidate.path,
        reason: result.error.message,
      });
    }
    return ok(fuseImageFact(candidate, digests, result.value));
  }

  async #goImage(
    image: ReleaseExposureNativeImage,
    options: ExecutionOptions | undefined,
  ): Promise<Result<MetadataImageFact, AnalysisError>> {
    if (image.format === "mach-o-universal")
      return ok({
        kind: "failed",
        path: image.path,
        reason: "universal Mach-O needs an architecture",
      });
    return this.#metadata(
      image.path,
      options,
      () =>
        this.owners.goBinaries.inspect(
          { path: image.path, detail: "complete" },
          options,
        ),
      goMetadata(image),
    );
  }

  async #rustImage(
    image: ReleaseExposureNativeImage,
    options: ExecutionOptions | undefined,
  ): Promise<Result<MetadataImageFact, AnalysisError>> {
    if (image.format === "mach-o-universal")
      return ok({
        kind: "failed",
        path: image.path,
        reason: "universal Mach-O needs an architecture",
      });
    return this.#metadata(
      image.path,
      options,
      () => this.owners.rustBinaries.inspect({ path: image.path }, options),
      rustMetadata(image),
    );
  }

  async #metadata(
    path: string,
    options: ExecutionOptions | undefined,
    run: () => Promise<Result<Evidence, AnalysisError>>,
    present: (value: Evidence) => MetadataImageFact,
  ): Promise<Result<MetadataImageFact, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(
        new AnalysisCancelledError(RELEASE_EXPOSURE_OPERATION, {
          cause: options.signal.reason,
        }),
      );
    try {
      const result = await run();
      if (!result.ok) {
        if (stopsAudit(result.error)) return err(result.error);
        if (
          result.error instanceof AnalysisUnsupportedTargetError &&
          !result.error.undecodedContent
        )
          return ok({ kind: "unsupported", path });
        return ok(failedMetadata(result.error.message, path));
      }
      return ok({ ...present(result.value), path });
    } catch (cause) {
      if (cause instanceof AnalysisError && stopsAudit(cause))
        return err(cause);
      return ok(
        failedMetadata(
          cause instanceof Error ? cause.message : String(cause),
          path,
        ),
      );
    }
  }
}

const OWNER_NOT_RUN =
  "The audit was cancelled or stopped on unfinished cleanup before this reader ran. Its checks are unknown.";
const IMAGE_CHANGED =
  "The file changed after inventory, so its findings were not attached.";

interface OwnerOutcome {
  readonly scan: ReleaseExposureScan;
  readonly facts: Omit<ReleaseExposureOwnerFacts, "credential_markers">;
  readonly stopped: AnalysisError | undefined;
}

/**
 * The Evidence an owner completed before observing cancellation, which
 * completeProviderEvidence carries as the error's partial observation.
 */
const completedOwnerEvidence = (error: AnalysisError): Evidence | undefined => {
  const partial = error.partialObservation;
  return evidenceSchema.safeParse(partial).success
    ? (partial as Evidence)
    : undefined;
};

/** Settle one fuse image from its owner's Evidence. */
const fuseImageFact = (
  candidate: ReleaseExposureFuseCandidate,
  digests: ReadonlyMap<string, string>,
  value: Evidence,
): FuseImageFact => {
  const report = electronFuseReportSchema.safeParse(value.normalized_result);
  if (!report.success)
    return {
      kind: "failed",
      role: candidate.role,
      path: candidate.path,
      reason: "Electron fuse report did not match its schema.",
    };
  if (fuseImageChanged(candidate, digests, report.data.artifact.sha256))
    return {
      kind: "failed",
      role: candidate.role,
      path: candidate.path,
      reason: IMAGE_CHANGED,
    };
  return {
    kind: "report",
    role: candidate.role,
    path: candidate.path,
    sha256: report.data.artifact.sha256,
    implications: fuseImplications(report.data),
  };
};

/** Settle one image's Go build paths from its owner's Evidence. */
const goMetadata =
  (image: ReleaseExposureNativeImage) =>
  (value: Evidence): MetadataImageFact => {
    const report = goBinarySchema.safeParse(value.normalized_result);
    if (!report.success)
      return failedMetadata("Go build metadata did not match its schema.");
    if (imageChanged(image, report.data.artifact.sha256))
      return failedMetadata(IMAGE_CHANGED);
    if (report.data.build_info === null) return { kind: "absent" };
    const extracted = goBuildPaths(report.data.build_info.module, image.format);
    return {
      kind: "paths",
      paths: extracted.paths,
      complete:
        report.data.build_info.module.complete && !extracted.ambiguousLinkerR,
      limitations: extracted.ambiguousLinkerR
        ? [
            ...report.data.limitations,
            "A GNU linker -R operand with an ELF runtime token may name either a symbol file or a runtime search path; its build-host applicability is unknown.",
          ]
        : report.data.limitations,
    };
  };

/** Settle one image's Rust dependency list from its owner's Evidence. */
const rustMetadata =
  (image: ReleaseExposureNativeImage) =>
  (value: Evidence): MetadataImageFact => {
    const report = rustBinarySchema.safeParse(value.normalized_result);
    if (!report.success)
      return failedMetadata(
        "Rust dependency metadata did not match its schema.",
      );
    if (imageChanged(image, report.data.artifact.sha256))
      return failedMetadata(IMAGE_CHANGED);
    if (report.data.auditable_metadata === null) return { kind: "absent" };
    return {
      kind: "packages",
      packages: report.data.auditable_metadata.packages.map(
        (item) => item.name,
      ),
    };
  };

/** A failure that ends the audit instead of staying on one check. */
const stopsAudit = (error: AnalysisError): boolean =>
  error instanceof AnalysisCancelledError || error.cleanupIncomplete;

/**
 * Attach this audit's report, which replaces an owner's own partial for one
 * image. An error with unfinished cleanup is kept, so its owner can resolve it.
 */
const withAuditPartial = (
  error: AnalysisError,
  report: Evidence,
): AnalysisError => {
  if (error.partialObservation !== undefined && !error.cleanupIncomplete)
    return new AnalysisCancelledError(RELEASE_EXPOSURE_OPERATION, {
      cause: error.cause,
      partialObservation: report,
    });
  error.partialObservation = report;
  return error;
};

/** Combine owner close failures without losing typed cleanup ownership. */
const ownerCloseFailure = (
  failures: readonly { readonly owner: string; readonly cause: unknown }[],
): unknown => {
  const [first] = failures;
  if (failures.length === 1 && first !== undefined) return first.cause;
  const typed = failures.flatMap(({ cause }) =>
    cause instanceof AnalysisError ? [cause] : [],
  );
  const resources = failures.flatMap(({ cause }) => {
    if (cause instanceof AnalysisError) return cause.cleanupResources;
    return cause instanceof ArtifactReaderFailure
      ? (cause.cleanup?.resources ?? [])
      : [];
  });
  const aggregate = new ProviderCleanupError(
    RELEASE_EXPOSURE_PROVIDER.id,
    [...new Set(resources)],
    {
      failures: failures.map(({ owner, cause }) => ({
        owner,
        failure:
          cause instanceof AnalysisError
            ? projectAnalysisError(cause)
            : {
                message: cause instanceof Error ? cause.message : String(cause),
              },
      })),
    },
    {
      cause: new AggregateError(
        failures.map(({ cause }) => cause),
        `Release exposure cleanup failed: ${failures.map(({ owner }) => owner).join(", ")}.`,
      ),
      operation: RELEASE_EXPOSURE_OPERATION,
    },
  );
  const live = typed.filter((cause) => cause.cleanupIncomplete);
  // An opaque rejection supplies no release authority, so it stays incomplete.
  if (live.length === failures.length) aggregate.bindCleanupDependencies(live);
  return aggregate;
};

/**
 * An app bundle resolves to a file through paths the inventory may spell
 * differently, so its digest must match some inventoried native image.
 */
const fuseImageChanged = (
  candidate: ReleaseExposureFuseCandidate,
  digests: ReadonlyMap<string, string>,
  sha256: string,
): boolean => {
  const expected = digests.get(candidate.path);
  if (expected !== undefined) return expected !== sha256;
  return digests.size > 0 && ![...digests.values()].includes(sha256);
};

/**
 * The bundle read lands on the framework file, which the sample may also list.
 * The bundle candidate comes first, so that image needs no second read.
 */
const bundleReadCovers = (
  candidate: ReleaseExposureFuseCandidate,
  digests: ReadonlyMap<string, string>,
  images: readonly FuseImageFact[],
): boolean => {
  const digest = digests.get(candidate.path);
  return (
    digest !== undefined &&
    images.some(
      (image) => image.role === "app-bundle" && image.sha256 === digest,
    )
  );
};

const imageChanged = (
  image: ReleaseExposureNativeImage,
  sha256: string,
): boolean => image.sha256 !== undefined && image.sha256 !== sha256;

/**
 * Keep decided implications and add unknown for each subject a sentinel or
 * slice left undecided, so one safe slice cannot stand for a universal file.
 * An image with no sentinel at all stays without implications.
 */
const fuseImplications = (
  report: ElectronFuseReport,
): NonNullable<FuseImageFact["implications"]> => {
  const decided = report.runtime_implications.map((item) => ({
    subject: item.subject,
    outcome: item.outcome,
  }));
  if (report.slices.every((slice) => slice.sentinels.length === 0))
    return decided;
  const decides = (subject: string, slice: number, offset: number): boolean =>
    report.runtime_implications.some(
      (item) =>
        item.subject === subject &&
        item.slice_index === slice &&
        item.sentinel_offset === offset,
    );
  const undecided = RELEASE_EXPOSURE_FUSE_SUBJECTS.filter((subject) =>
    report.slices.some(
      (slice) =>
        slice.sentinels.length === 0 ||
        slice.sentinels.some(
          (sentinel) =>
            !decides(subject, slice.index, sentinel.sentinel_offset),
        ),
    ),
  );
  return [
    ...decided,
    ...undecided.map((subject) => ({ subject, outcome: "unknown" })),
  ];
};

const failedMetadata = (reason: string, path?: string): MetadataImageFact => ({
  kind: "failed",
  reason,
  ...(path === undefined ? {} : { path }),
});

/**
 * A file an Electron candidate rests on: its native path, and whether the
 * desktop owner's slash-separated path for it is an ASAR layout. A Windows
 * native path such as `C:\\ship\\App\\resources\\app.asar` does not split
 * on `/`, so the layout is read from the owner's path.
 */
interface ArchiveBasis {
  readonly path: string;
  readonly electronArchive: boolean;
  /**
   * The owner's slash-separated layout folder for this archive, relative to
   * the read root. It names the layout without the caller's path spelling.
   */
  readonly layout: string;
}

interface DesktopFamilyFact {
  readonly family: ReleaseExposureOwnerFacts["electron_family"];
  readonly reason: string | null;
  readonly archivePaths: readonly ArchiveBasis[];
  /** False when discovery stopped before it listed every ASAR layout. */
  readonly layoutsComplete?: boolean;
}

/**
 * The desktop owner resolves its root, so a target selected through a
 * symlinked parent (`/tmp/App` for `/private/tmp/App`) gets canonical
 * `local_path`s while the audit's images keep the caller's spelling. Rebase an
 * owner path under the canonical root onto the selected path so the two join.
 */
const callerPath = (
  localPath: string,
  canonicalRoot: string,
  selectedPath: string,
): string => {
  if (canonicalRoot === selectedPath) return localPath;
  if (localPath === canonicalRoot) return selectedPath;
  const separator = localPath.charAt(canonicalRoot.length);
  if (
    localPath.startsWith(canonicalRoot) &&
    (separator === "/" || separator === "\\")
  )
    // A selected `/work/app/` must still yield `/work/app/resources/...`, so
    // the archive's layout folder matches the inventoried images' parent.
    return appendCallerPath(
      selectedPath,
      localPath.slice(canonicalRoot.length + 1),
      separator === "\\" ? "win32" : "linux",
    );
  return localPath;
};

/**
 * The desktop owner names Electron only from an ASAR layout, so an `asar: false`
 * build has no candidate. Having none leaves the family undecided, except for an
 * app bundle with no Electron Framework: the fuses have nowhere to live.
 */
const desktopFamily = (
  evidence: Evidence,
  targetKind: ReleaseExposureScan["target"]["kind"],
  selectedPath: string,
): DesktopFamilyFact => {
  const report = desktopApplicationSchema.safeParse(evidence.normalized_result);
  if (!report.success)
    return {
      family: "unknown",
      reason: "Desktop application report did not match its schema.",
      archivePaths: [],
    };
  const electron = report.data.candidates.find(
    (candidate) => candidate.family === "electron",
  );
  if (electron !== undefined) {
    const files = new Map(
      report.data.files.map((file) => [file.file_id, file]),
    );
    const partial = report.data.coverage.status === "partial";
    return {
      family: "electron",
      // A partial discovery may have stopped before another layout's host.
      reason: partial ? "Desktop application coverage is partial." : null,
      layoutsComplete: !partial,
      archivePaths: electron.basis_file_ids.flatMap((id) => {
        const file = files.get(id);
        return file === undefined
          ? []
          : [
              {
                path: callerPath(
                  file.local_path,
                  report.data.root.canonical_path,
                  selectedPath,
                ),
                electronArchive: desktopPathConventions(file.path)
                  .electronArchive,
                layout: posix.dirname(posix.dirname(file.path)),
              },
            ];
      }),
    };
  }
  if (report.data.coverage.status === "partial")
    return {
      family: "unknown",
      reason: "Desktop application coverage is partial.",
      archivePaths: [],
    };
  if (
    targetKind === "app" &&
    !report.data.files.some(
      (file) => desktopPathConventions(file.path).electronFramework,
    )
  )
    return { family: "not_electron", reason: null, archivePaths: [] };
  return {
    family: "unknown",
    reason:
      "No ASAR layout was found, and no fuse read has ruled out an asar: false Electron build.",
    archivePaths: [],
  };
};

/**
 * A directory is not Electron only when every native image in it was read and
 * none holds a fuse sentinel. An unread image could be the Electron executable,
 * including one inside a packaged member the fuse reader was never sent.
 */
const fuseImagesRuleOutElectron = (
  family: DesktopFamilyFact["family"],
  scan: ReleaseExposureScan,
  images: readonly FuseImageFact[],
): boolean =>
  family === "unknown" &&
  scan.target.kind === "directory" &&
  images.length > 0 &&
  !nativeImagesMayBeUnread(scan) &&
  images.every(
    (image) => image.kind === "report" && image.implications?.length === 0,
  );

/** A Windows absolute path is read with Windows separators on any host. */
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/u;
const nativeDirname = (path: string): string =>
  WINDOWS_ABSOLUTE_PATH.test(path) ? win32.dirname(path) : dirname(path);
const nativeBasename = (path: string): string =>
  WINDOWS_ABSOLUTE_PATH.test(path) ? win32.basename(path) : basename(path);

const limitNativeSample = (
  scan: ReleaseExposureScan,
  basisPaths: readonly ArchiveBasis[],
  familyUndecided: boolean,
): {
  readonly scan: ReleaseExposureScan;
  readonly electronExecutableIncluded: boolean;
  readonly electronHostPaths: readonly string[];
} => {
  const ranked = electronExecutableRank(scan.native_images, basisPaths);
  const preferred = scan.native_images
    .filter((image) => ranked.has(image.path))
    .sort(
      (left, right) =>
        (ranked.get(left.path) ?? 0) - (ranked.get(right.path) ?? 0),
    );
  const preferredPaths = new Set(preferred.map((image) => image.path));
  const kept = [
    ...preferred,
    ...scan.native_images.filter((image) => !preferredPaths.has(image.path)),
  ].slice(0, MAX_RELEASE_EXPOSURE_NATIVE_IMAGES);
  const omittedNative = scan.native_images.length - kept.length;
  const keptPaths = new Set(kept.map((image) => image.path));
  // With no named host, any sampled sibling could be it, so none settles alone.
  const hostsAmong = (
    images: readonly ReleaseExposureNativeImage[],
  ): ReleaseExposureNativeImage[] => {
    const named = images.filter(
      (image) =>
        (ranked.get(image.path) ?? ANY_SIBLING_RANK) < ANY_SIBLING_RANK,
    );
    return named.length > 0
      ? named
      : images.filter((image) => ranked.has(image.path));
  };
  // A layout is read only when every host it could have was sampled: one with
  // both `a.exe` and `electron.exe` is not settled by reading one of them.
  // With no named host, that holds only when every executable was listed.
  const hostRead = (hosts: readonly ReleaseExposureNativeImage[]): boolean => {
    const candidates = hostsAmong(hosts);
    const named = candidates.some(
      (image) =>
        (ranked.get(image.path) ?? ANY_SIBLING_RANK) < ANY_SIBLING_RANK,
    );
    return (
      (named || scan.coverage !== "unknown") &&
      candidates.length > 0 &&
      candidates.every((image) => keptPaths.has(image.path))
    );
  };
  // Each ASAR layout has its own host, so one read host covers only its own.
  const layouts = [
    ...new Set(
      basisPaths
        .filter((basis) => basis.electronArchive)
        .map((basis) => nativeDirname(nativeDirname(basis.path))),
    ),
  ];
  // A bundle or selected-executable read settles only its own layout: an app
  // that embeds another Electron app still needs that app's host read. The
  // layout is named by the owner's relative path, which carries no caller
  // spelling, and looked up by the owner's resolved folder.
  const selectedRead = kept.some(
    (image) => image.path === scan.target.selected_path,
  );
  const bundleRead =
    scan.target.kind === "app" ||
    scan.fuse_candidates.some((candidate) => candidate.role === "app-bundle");
  const settledLayouts = new Set(
    basisPaths
      .filter(
        (basis) =>
          basis.electronArchive &&
          ((bundleRead && basis.layout === "Contents") ||
            (selectedRead && basis.layout === ".")),
      )
      .map((basis) => nativeDirname(nativeDirname(basis.path))),
  );
  // An asar: false build names no layout, so a native image outside every
  // found layout that the sample dropped may be another build's unread host.
  // Its name does not rule it out: a host can be named `My.App`. An incomplete
  // inventory may have stopped before listing such an image, even when the
  // read root is itself a found layout: a build nested below it is outside it.
  const missedOutsideHost =
    scan.coverage === "unknown" ||
    scan.native_images.some(
      (image) =>
        !keptPaths.has(image.path) &&
        !layouts.some((folder) => inLayout(folder, image.path)),
    );
  // A bundle read with no layout settles only the root build: a nested
  // asar: false build's host may be one the sample or inventory missed.
  const electronExecutableIncluded =
    layouts.length === 0
      ? (bundleRead && !missedOutsideHost) ||
        selectedRead ||
        hostRead(preferred)
      : !missedOutsideHost &&
        layouts.every(
          (folder) =>
            settledLayouts.has(folder) ||
            hostRead(preferred.filter((image) => inLayout(folder, image.path))),
        );
  const outside = kept.filter(
    (image) => !layouts.some((folder) => inLayout(folder, image.path)),
  );
  const outsideHosts = hostsAmong(outside);
  // A build without an ASAR names no host, so any sampled image outside the
  // discovered layouts may carry another build's fuses and none settles
  // another alone. That holds beside a found layout and, with none found,
  // while the family is undecided.
  const unnamedHosts =
    outsideHosts.length === 0 && (layouts.length > 0 || familyUndecided)
      ? outside
      : outsideHosts;
  // A named host settles only its own layout, so each layout chooses its hosts.
  const hosts = [
    ...unnamedHosts,
    ...layouts.flatMap((folder) => {
      const found = hostsAmong(
        kept.filter((image) => inLayout(folder, image.path)),
      );
      // A bundle's framework carries its fuses, so a launcher beside it is
      // sampled but is not a fuse host.
      const framework = found.filter((image) =>
        inMacFramework(folder, image.path),
      );
      return framework.length > 0 ? framework : found;
    }),
  ];
  return {
    electronExecutableIncluded,
    electronHostPaths: hosts.map((image) => image.path),
    scan: {
      ...scan,
      native_images: kept,
      // The bundle read covers one framework file, not the images beside it.
      fuse_candidates: [
        ...scan.fuse_candidates.filter(
          (candidate) => candidate.role === "app-bundle",
        ),
        ...kept.map((image) => ({
          path: image.path,
          role: "native-image" as const,
        })),
      ],
      omitted: [
        ...scan.omitted.filter((item) => item.subject !== "native images"),
        ...(omittedNative > 0
          ? [
              {
                subject: "native images",
                count: omittedNative,
                reason: `Only ${String(MAX_RELEASE_EXPOSURE_NATIVE_IMAGES)} native images are passed to language and fuse readers.`,
              },
            ]
          : []),
      ],
    },
  };
};

/**
 * A lower rank names the Electron host. This one only orders the sample: any
 * executable beside the archive could be a helper.
 */
const ANY_SIBLING_RANK = 2;
/**
 * A dotted name such as `my.app` is sampled after plain siblings, but it can
 * still be the host, so its extension does not rule it out.
 */
const DOTTED_SIBLING_RANK = 3;
/** Shared library names, which a loader maps into a host rather than runs. */
const SHARED_LIBRARY_NAME = /\.(?:dll|dylib|node|so(?:\.\d+)*)$/iu;

const electronExecutableRank = (
  images: readonly ReleaseExposureNativeImage[],
  basisPaths: readonly ArchiveBasis[],
): Map<string, number> => {
  const imagePaths = new Set(images.map((image) => image.path));
  const ranked = new Map<string, number>();
  const remember = (path: string, score: number) => {
    const previous = ranked.get(path);
    if (previous === undefined || score < previous) ranked.set(path, score);
  };
  for (const basis of basisPaths) {
    if (imagePaths.has(basis.path)) remember(basis.path, 0);
    if (!basis.electronArchive) continue;
    const folder = nativeDirname(nativeDirname(basis.path));
    const bundle = macBundleName(folder);
    const folderName = (bundle ?? nativeBasename(folder)).toLowerCase();
    for (const image of images) {
      if (!inLayout(folder, image.path)) continue;
      const name = nativeBasename(image.path);
      const lower = name.toLowerCase();
      // The framework binary carries a bundle's fuses.
      if (bundle !== null && lower === "electron framework")
        remember(image.path, 0);
      else if (lower === folderName || lower === `${folderName}.exe`)
        remember(image.path, 0);
      else if (lower === "electron" || lower === "electron.exe")
        remember(image.path, 1);
      else if (lower.endsWith(".exe") || !name.includes("."))
        remember(image.path, ANY_SIBLING_RANK);
      else if (!SHARED_LIBRARY_NAME.test(name))
        remember(image.path, DOTTED_SIBLING_RANK);
    }
  }
  return ranked;
};

/**
 * A macOS bundle's ASAR layout resolves to its `Contents` folder, while its
 * hosts are `Contents/MacOS/*` and the Electron framework binary under
 * `Contents/Frameworks`. Its name is the bundle's, without `.app`.
 */
const macBundleName = (folder: string): string | null => {
  if (WINDOWS_ABSOLUTE_PATH.test(folder) || basename(folder) !== "Contents")
    return null;
  const bundle = basename(dirname(folder));
  return bundle.toLowerCase().endsWith(".app") ? bundle.slice(0, -4) : null;
};

const MAC_ELECTRON_FRAMEWORK = "Frameworks/Electron Framework.framework/";

/** Whether an image is one of the hosts an ASAR layout's folder can have. */
const inLayout = (folder: string, path: string): boolean => {
  if (nativeDirname(path) === folder) return true;
  if (macBundleName(folder) === null) return false;
  return dirname(path) === `${folder}/MacOS` || inMacFramework(folder, path);
};

/** Whether an image is inside a macOS bundle layout's Electron framework. */
const inMacFramework = (folder: string, path: string): boolean =>
  macBundleName(folder) !== null &&
  path.startsWith(`${folder}/${MAC_ELECTRON_FRAMEWORK}`);
