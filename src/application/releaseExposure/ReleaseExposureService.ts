import { basename, dirname } from "node:path";

import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { DesktopApplicationService } from "../artifacts/DesktopApplicationService.js";
import type { ElectronFuseService } from "../electron/ElectronFuseService.js";
import type { GoBinaryService } from "../go/GoBinaryService.js";
import type { RustBinaryService } from "../rust/RustBinaryService.js";
import { parseAnalysisInput } from "../AnalysisInput.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
  AnalysisUnsupportedTargetError,
} from "../../domain/analysisErrorCore.js";
import { desktopApplicationSchema } from "../../domain/desktopApplication.js";
import { desktopPathConventions } from "../../domain/nativeConvention.js";
import { electronFuseReportSchema } from "../../domain/electron/electronFuses.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { evidenceSubjectFormatSchema } from "../../domain/evidenceSubject.js";
import { goBinarySchema, type GoBinary } from "../../domain/go/goBinary.js";
import { RELEASE_EXPOSURE_PROVIDER } from "../../domain/investigationProviders.js";
import {
  scanCredentialMarkers,
  type CredentialMarkerHit,
} from "../../domain/releaseExposureCredentialMarkers.js";
import {
  assembleReleaseExposureReport,
  auditReleaseExposureInputSchema,
  MAX_RELEASE_EXPOSURE_NATIVE_IMAGES,
  RELEASE_EXPOSURE_OPERATION,
  type FuseImageFact,
  type MetadataImageFact,
  type ReleaseExposureFuseCandidate,
  type ReleaseExposureNativeImage,
  type ReleaseExposureOwnerFacts,
  type ReleaseExposureScan,
} from "../../domain/releaseExposure.js";
import { err, ok, type Result } from "../../domain/result.js";
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
    if (failures.length === 0) return;
    throw new AggregateError(
      failures.map((failure) => failure.cause),
      `Release exposure cleanup failed: ${failures.map((failure) => failure.owner).join(", ")}.`,
    );
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
    const scanned = await this.owners.reader.inspect(
      input.value,
      options,
      (text, location) => {
        const markers = scanCredentialMarkers(text, location);
        markerHits.push(...markers.hits);
        omittedMarkerHits += markers.omitted_hits;
      },
    );
    if (!scanned.ok) return scanned;
    const owned = await this.#owners(scanned.value, options);
    if (!owned.ok) return owned;
    let report;
    try {
      report = assembleReleaseExposureReport(owned.value.scan, {
        ...owned.value.facts,
        credential_markers: {
          hits: markerHits,
          omitted_hits: omittedMarkerHits,
        },
      });
    } catch (cause) {
      return err(
        new AnalysisOutputError(
          RELEASE_EXPOSURE_OPERATION,
          "Release exposure report did not match its schema.",
          { cause },
        ),
      );
    }
    const format = evidenceSubjectFormatSchema.safeParse(
      scanned.value.subject.format,
    );
    return completeProviderEvidence(
      createEvidence(
        {
          path: scanned.value.subject.path,
          sha256: scanned.value.subject.sha256,
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
              path: scanned.value.target.selected_path,
            },
          ],
        },
      ),
      options?.signal,
    );
  }

  async #owners(
    scan: ReleaseExposureScan,
    options: ExecutionOptions | undefined,
  ): Promise<
    Result<
      {
        readonly scan: ReleaseExposureScan;
        readonly facts: Omit<ReleaseExposureOwnerFacts, "credential_markers">;
      },
      AnalysisError
    >
  > {
    const desktop = await this.#desktopFamily(scan, options);
    if (!desktop.ok) return desktop;
    const prepared = limitNativeSample(scan, desktop.value.archivePaths);
    const fuseImages: FuseImageFact[] = [];
    for (const candidate of prepared.scan.fuse_candidates) {
      const image = await this.#fuseImage(candidate, options);
      if (!image.ok) return image;
      fuseImages.push(image.value);
    }
    const goImages: MetadataImageFact[] = [];
    const rustImages: MetadataImageFact[] = [];
    for (const image of prepared.scan.native_images) {
      const go = await this.#goImage(image, options);
      if (!go.ok) return go;
      goImages.push(go.value);
      const rust = await this.#rustImage(image, options);
      if (!rust.ok) return rust;
      rustImages.push(rust.value);
    }
    return ok({
      scan: prepared.scan,
      facts: {
        electron_family: desktop.value.family,
        electron_family_reason: desktop.value.reason,
        electron_executable_included: prepared.electronExecutableIncluded,
        fuse_images: fuseImages,
        go_images: goImages,
        rust_images: rustImages,
      },
    });
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
        if (result.error instanceof AnalysisCancelledError)
          return err(result.error);
        return ok({
          family: "unknown",
          reason: result.error.message,
          archivePaths: [],
        });
      }
      return ok(desktopFamily(result.value));
    } catch (cause) {
      if (cause instanceof AnalysisCancelledError) return err(cause);
      return ok({
        family: "unknown",
        reason: cause instanceof Error ? cause.message : String(cause),
        archivePaths: [],
      });
    }
  }

  async #fuseImage(
    candidate: ReleaseExposureFuseCandidate,
    options: ExecutionOptions | undefined,
  ): Promise<Result<FuseImageFact, AnalysisError>> {
    let result: Result<Evidence, AnalysisError>;
    try {
      result = await this.owners.electronFuses.inspect(
        { path: candidate.path },
        options,
      );
    } catch (cause) {
      if (cause instanceof AnalysisCancelledError) return err(cause);
      return ok({
        kind: "failed",
        role: candidate.role,
        path: candidate.path,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (!result.ok) {
      if (result.error instanceof AnalysisCancelledError)
        return err(result.error);
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
    const report = electronFuseReportSchema.safeParse(
      result.value.normalized_result,
    );
    if (!report.success)
      return ok({
        kind: "failed",
        role: candidate.role,
        path: candidate.path,
        reason: "Electron fuse report did not match its schema.",
      });
    return ok({
      kind: "report",
      role: candidate.role,
      path: candidate.path,
      implications: report.data.runtime_implications.map((item) => ({
        subject: item.subject,
        outcome: item.outcome,
      })),
    });
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
      (value) => {
        const report = goBinarySchema.safeParse(value.normalized_result);
        if (!report.success)
          return failedMetadata("Go build metadata did not match its schema.");
        if (report.data.build_info === null) return { kind: "absent" };
        return {
          kind: "paths",
          paths: goPaths(report.data.build_info.module),
          complete: report.data.build_info.module.complete,
          limitations: report.data.limitations,
        };
      },
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
      (value) => {
        const report = rustBinarySchema.safeParse(value.normalized_result);
        if (!report.success)
          return failedMetadata(
            "Rust dependency metadata did not match its schema.",
          );
        if (report.data.auditable_metadata === null) return { kind: "absent" };
        return {
          kind: "packages",
          packages: report.data.auditable_metadata.packages.map(
            (item) => item.name,
          ),
        };
      },
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
        if (result.error instanceof AnalysisCancelledError)
          return err(result.error);
        if (result.error instanceof AnalysisUnsupportedTargetError)
          return ok({ kind: "unsupported", path });
        return ok(failedMetadata(result.error.message, path));
      }
      return ok({ ...present(result.value), path });
    } catch (cause) {
      if (cause instanceof AnalysisCancelledError) return err(cause);
      return ok(
        failedMetadata(
          cause instanceof Error ? cause.message : String(cause),
          path,
        ),
      );
    }
  }
}

const failedMetadata = (reason: string, path?: string): MetadataImageFact => ({
  kind: "failed",
  reason,
  ...(path === undefined ? {} : { path }),
});

interface DesktopFamilyFact {
  readonly family: ReleaseExposureOwnerFacts["electron_family"];
  readonly reason: string | null;
  readonly archivePaths: readonly string[];
}

const desktopFamily = (evidence: Evidence): DesktopFamilyFact => {
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
      report.data.files.map((file) => [file.file_id, file.local_path]),
    );
    return {
      family: "electron",
      reason: null,
      archivePaths: electron.basis_file_ids.flatMap((id) => {
        const path = files.get(id);
        return path === undefined ? [] : [path];
      }),
    };
  }
  if (report.data.coverage.status === "partial")
    return {
      family: "unknown",
      reason: "Desktop application coverage is partial.",
      archivePaths: [],
    };
  return { family: "not_electron", reason: null, archivePaths: [] };
};

const limitNativeSample = (
  scan: ReleaseExposureScan,
  basisPaths: readonly string[],
): {
  readonly scan: ReleaseExposureScan;
  readonly electronExecutableIncluded: boolean;
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
  const electronExecutableIncluded =
    scan.target.kind === "app" ||
    scan.fuse_candidates.some((candidate) => candidate.role === "app-bundle") ||
    kept.some((image) => preferredPaths.has(image.path));
  return {
    electronExecutableIncluded,
    scan: {
      ...scan,
      native_images: kept,
      fuse_candidates:
        scan.target.kind === "app"
          ? scan.fuse_candidates
          : kept.map((image) => ({
              path: image.path,
              role: "native-image" as const,
            })),
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

const electronExecutableRank = (
  images: readonly ReleaseExposureNativeImage[],
  basisPaths: readonly string[],
): Map<string, number> => {
  const imagePaths = new Set(images.map((image) => image.path));
  const ranked = new Map<string, number>();
  const remember = (path: string, score: number) => {
    const previous = ranked.get(path);
    if (previous === undefined || score < previous) ranked.set(path, score);
  };
  for (const basis of basisPaths) {
    if (imagePaths.has(basis)) remember(basis, 0);
    if (!desktopPathConventions(basis).electronArchive) continue;
    const folder = dirname(dirname(basis));
    const folderName = basename(folder).toLowerCase();
    for (const image of images) {
      if (dirname(image.path) !== folder) continue;
      const name = basename(image.path);
      const lower = name.toLowerCase();
      let score = 3;
      if (lower === folderName || lower === `${folderName}.exe`) score = 0;
      else if (lower === "electron" || lower === "electron.exe") score = 1;
      else if (lower.endsWith(".exe") || !name.includes(".")) score = 2;
      if (score <= 2) remember(image.path, score);
    }
  }
  return ranked;
};

const filesystemPath = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined || value.length === 0) return null;
  if (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.includes("\\") ||
    /^[A-Za-z]:[\\/]/u.test(value)
  )
    return value;
  return null;
};

const goPaths = (
  module: NonNullable<GoBinary["build_info"]>["module"],
): string[] => {
  const paths = new Set<string>();
  const add = (value: string | null | undefined) => {
    const path = filesystemPath(value);
    if (path !== null) paths.add(path);
  };
  add(module.path);
  add(module.main?.path);
  add(module.main?.replacement?.path);
  for (const dependency of module.dependencies) {
    add(dependency.path);
    add(dependency.replacement?.path);
  }
  return [...paths];
};
