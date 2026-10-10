import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import type {
  ExecutionOptions,
  ProviderAvailability,
} from "../application/AnalysisProvider.js";
import {
  createAnalysisExecution,
  type AnalysisExecution,
} from "../application/AnalysisProvider.js";
import type { FlutterRequest } from "../domain/flutter/flutterBuildAnalysis.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ArtifactEntry } from "../artifacts/ArtifactReader.js";
import { ZipArtifactReader } from "../artifacts/ZipArtifactReader.js";
import {
  BuildIdScanner,
  LabeledStringScanner,
  SnapshotHashScanner,
} from "./FlutterPayloadScan.js";

/** Stable identity for the Flutter build-identification provider. */
export const FLUTTER_PROVIDER_IDENTITY = {
  id: "flutter",
  name: "Flutter build identification",
  version: null,
} as const;

const APK_METADATA_READ_MAX_BYTES = 8 * 1024 * 1024;
const LIBRARY_MAX_BYTES = 256 * 1024 * 1024;

/** Stream a local file digest without retaining large APKs in memory. */
const sha256File = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

interface LibraryFacts {
  readonly libapp: {
    present: boolean;
    bytes: number | null;
    sha256: string | null;
    sources: number;
    candidates: readonly string[];
  };
  readonly libflutter: {
    present: boolean;
    bytes: number | null;
    sha256: string | null;
    buildId: string | null;
    dartVersion: string | null;
    toolchainLines: readonly string[];
  };
}

const emptyFacts = (): LibraryFacts => ({
  libapp: {
    present: false,
    bytes: null,
    sha256: null,
    sources: 0,
    candidates: [],
  },
  libflutter: {
    present: false,
    bytes: null,
    sha256: null,
    buildId: null,
    dartVersion: null,
    toolchainLines: [],
  },
});

export interface FlutterProviderOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/**
 * Flutter build identification by pure parsing: reads `lib/<abi>/libapp.so`
 * and `libflutter.so` through the hardened ZIP reader and reports the Dart
 * snapshot hash, GNU build-id, and any labeled version strings verbatim.
 * Runs no engine, installs nothing, and performs no external lookups.
 */
export class FlutterBuildProvider {
  readonly environment: Readonly<Record<string, string | undefined>>;

  constructor(options: FlutterProviderOptions = {}) {
    this.environment = options.environment ?? process.env;
  }

  /** Pure parsing; the provider is always available. */
  async inspectAvailability(): Promise<ProviderAvailability> {
    return {
      status: "available",
      code: null,
      reason: null,
      diagnostics: { engine: "static-apk-parsing" },
    };
  }

  /** The provider holds no long-lived resources. */
  async close(): Promise<void> {}

  async execute(
    request: FlutterRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (options?.signal?.aborted === true)
      return err(new AnalysisCancelledError(request.operation));
    const { path } = request.input;
    const info = await stat(path).then(
      (value) => value,
      () => null,
    );
    if (info === null || !info.isFile())
      return err(
        new AnalysisInputError(request.operation, {
          cause: new Error(`The selected APK is not a readable file: ${path}`),
        }),
      );
    const sha256 = await sha256File(path);
    const reader = new ZipArtifactReader(
      path,
      "apk",
      APK_METADATA_READ_MAX_BYTES,
    );
    try {
      const flutterEntries = new Map<
        string,
        { entry: ArtifactEntry; abi: string; kind: "libapp" | "libflutter" }
      >();
      for await (const entry of reader.entries(options?.signal)) {
        if (entry.kind !== "file") continue;
        const match = /^lib\/([^/]+)\/(libapp|libflutter)\.so$/u.exec(
          entry.path,
        );
        if (match === null) continue;
        if (
          entry.declaredSize !== null &&
          entry.declaredSize > LIBRARY_MAX_BYTES
        )
          return err(
            new AnalysisResourceConstraintError(
              request.operation,
              "file-size",
              `${entry.path} declares ${String(entry.declaredSize)} bytes, exceeding the ${String(LIBRARY_MAX_BYTES)}-byte read budget`,
              { max_library_bytes: LIBRARY_MAX_BYTES, entry_path: entry.path },
            ),
          );
        flutterEntries.set(entry.path, {
          entry,
          abi: match[1]!,
          kind: match[2]! === "libapp" ? "libapp" : "libflutter",
        });
      }
      const facts = new Map<string, LibraryFacts>();
      for (const { entry, abi, kind } of flutterEntries.values()) {
        const stream = await reader.open(entry, options?.signal);
        const hash = createHash("sha256");
        const snapshotScanner = new SnapshotHashScanner();
        const buildIdScanner = new BuildIdScanner();
        const labeledScanner = new LabeledStringScanner();
        let bytes = 0;
        for await (const chunk of stream) {
          const view = chunk as Buffer;
          bytes += view.byteLength;
          if (bytes > LIBRARY_MAX_BYTES)
            return err(
              new AnalysisResourceConstraintError(
                request.operation,
                "file-size",
                `${entry.path} exceeds the ${String(LIBRARY_MAX_BYTES)}-byte read budget while streaming`,
                {
                  max_library_bytes: LIBRARY_MAX_BYTES,
                  entry_path: entry.path,
                },
              ),
            );
          hash.update(view);
          if (kind === "libapp") snapshotScanner.push(view);
          else {
            buildIdScanner.push(view);
            labeledScanner.push(view);
          }
        }
        const digest = hash.digest("hex");
        const current = facts.get(abi) ?? emptyFacts();
        if (kind === "libapp") {
          const scan = snapshotScanner.result();
          facts.set(abi, {
            ...current,
            libapp: {
              present: true,
              bytes,
              sha256: digest,
              sources: scan.sources,
              candidates: scan.candidates,
            },
          });
        } else {
          facts.set(abi, {
            ...current,
            libflutter: {
              present: true,
              bytes,
              sha256: digest,
              buildId: buildIdScanner.result(),
              dartVersion: labeledScanner.result().dartVersion,
              toolchainLines: labeledScanner.result().toolchainLines,
            },
          });
        }
      }
      const abis = [...facts.entries()]
        .map(([abi, value]) => ({
          abi,
          libapp: {
            present: value.libapp.present,
            bytes: value.libapp.bytes,
            sha256: value.libapp.sha256,
            snapshot_hash_sources: value.libapp.sources,
            snapshot_hash_candidates: [...value.libapp.candidates],
            snapshot_hash:
              value.libapp.candidates.length === 1
                ? value.libapp.candidates[0]!
                : null,
          },
          libflutter: {
            present: value.libflutter.present,
            bytes: value.libflutter.bytes,
            sha256: value.libflutter.sha256,
            build_id: value.libflutter.buildId,
            dart_version: value.libflutter.dartVersion,
            toolchain_lines: [...value.libflutter.toolchainLines],
          },
        }))
        .sort((left, right) => left.abi.localeCompare(right.abi));
      const flutterDetected = abis.some((entry) => entry.libapp.present);
      const partial = abis.some(
        (entry) =>
          (entry.libapp.present &&
            (entry.libapp.snapshot_hash === null ||
              entry.libapp.snapshot_hash_sources === 0)) ||
          entry.libapp.present !== entry.libflutter.present,
      );
      return ok(
        createAnalysisExecution(
          {
            target: { path, bytes: info.size, sha256 },
            flutter_detected: flutterDetected,
            abis,
            coverage: partial ? "partial" : "complete",
          },
          FLUTTER_PROVIDER_IDENTITY,
          {
            limitations: [
              "The snapshot hash identifies a Dart SDK build only against an external mapping dataset; REA performs no lookup",
              "Release engine builds often carry no labeled Dart version string; absence is reported, not guessed",
              "The snapshot hash sits 20 bytes after each snapshot magic in the AOT payload; findings are observations of that layout",
              ...(flutterDetected
                ? []
                : [
                    "No lib/*/libapp.so was found; the target does not carry a Flutter AOT payload",
                  ]),
            ],
          },
        ),
      );
    } finally {
      await reader.close().catch(() => undefined);
    }
  }
}
