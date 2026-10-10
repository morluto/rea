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
  AnalysisUnsupportedTargetError,
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
import { readElfSymbol, readSnapshotHeader } from "./DartElf.js";

/** Stable identity for the Flutter build-identification provider. */
export const FLUTTER_PROVIDER_IDENTITY = {
  id: "flutter",
  name: "Flutter build identification",
  version: null,
} as const;

const APK_METADATA_READ_MAX_BYTES = 8 * 1024 * 1024;
const LIBRARY_MAX_BYTES = 256 * 1024 * 1024;
const MAX_POOL_URIS = 500;
const MAX_POOL_TOKENS = 2_000;
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

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
    if (request.operation === "inspect_dart_aot")
      return this.inspectDartAot(
        request.input.path,
        request.input.abi,
        options?.signal,
      );
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

  private async inspectDartAot(
    path: string,
    abi: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const info = await stat(path).then(
      (value) => value,
      () => null,
    );
    if (info === null || !info.isFile())
      return err(
        new AnalysisInputError("inspect_dart_aot", {
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
      const candidates: { entry: ArtifactEntry; abi: string }[] = [];
      for await (const entry of reader.entries(signal)) {
        if (entry.kind !== "file") continue;
        const match = /^lib\/([^/]+)\/libapp\.so$/u.exec(entry.path);
        if (match === null) continue;
        if (
          entry.declaredSize !== null &&
          entry.declaredSize > LIBRARY_MAX_BYTES
        )
          return err(
            new AnalysisResourceConstraintError(
              "inspect_dart_aot",
              "file-size",
              `${entry.path} declares ${String(entry.declaredSize)} bytes, exceeding the ${String(LIBRARY_MAX_BYTES)}-byte read budget`,
              { max_library_bytes: LIBRARY_MAX_BYTES, entry_path: entry.path },
            ),
          );
        candidates.push({ entry, abi: match[1]! });
      }
      if (candidates.length === 0)
        return err(
          new AnalysisUnsupportedTargetError(
            "inspect_dart_aot",
            path,
            "No lib/<abi>/libapp.so was found; the target carries no Dart AOT payload",
          ),
        );
      const preference = ["arm64-v8a", "x86_64", "x86", "armeabi-v7a"];
      const selected =
        abi === undefined
          ? [...candidates].sort(
              (left, right) =>
                (preference.indexOf(left.abi) + 1 || preference.length + 1) -
                  (preference.indexOf(right.abi) + 1 ||
                    preference.length + 1) || left.abi.localeCompare(right.abi),
            )[0]!
          : candidates.find((candidate) => candidate.abi === abi);
      if (selected === undefined)
        return err(
          new AnalysisUnsupportedTargetError(
            "inspect_dart_aot",
            path,
            `No libapp.so was found for ABI ${abi ?? "(none)"}; available: ${candidates
              .map((candidate) => candidate.abi)
              .join(", ")}`,
          ),
        );
      const stream = await reader.open(selected.entry, signal);
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of stream) {
        const view = chunk as Buffer;
        total += view.byteLength;
        if (total > LIBRARY_MAX_BYTES)
          return err(
            new AnalysisResourceConstraintError(
              "inspect_dart_aot",
              "file-size",
              `lib/${selected.abi}/libapp.so exceeds the ${String(LIBRARY_MAX_BYTES)}-byte read budget while streaming`,
              { max_library_bytes: LIBRARY_MAX_BYTES },
            ),
          );
        chunks.push(view);
      }
      const image = Buffer.concat(chunks);
      const imageSha256 = createHash("sha256").update(image).digest("hex");
      const symbolNames = [
        "_kDartVmSnapshotData",
        "_kDartVmSnapshotInstructions",
        "_kDartIsolateSnapshotData",
        "_kDartIsolateSnapshotInstructions",
      ];
      const sections: {
        name: string;
        offset: number;
        size: number;
        magic_valid: boolean;
        kind: number | null;
        header_length: number | null;
      }[] = [];
      let isolateData: Buffer | null = null;
      const scanner = new SnapshotHashScanner();
      scanner.push(image);
      const hashScan = scanner.result();
      for (const name of symbolNames) {
        const parsed = readElfSymbol(image, name);
        if ("failure" in parsed) continue;
        const header = readSnapshotHeader(image, parsed.symbol.offset);
        sections.push({
          name,
          offset: parsed.symbol.offset,
          size: parsed.symbol.size,
          magic_valid: header.magicValid,
          kind: header.kind,
          header_length: header.headerLength,
        });
        if (name === "_kDartIsolateSnapshotData")
          isolateData = image.subarray(
            parsed.symbol.offset,
            parsed.symbol.offset + parsed.symbol.size,
          );
      }
      if (sections.length === 0)
        return err(
          new AnalysisUnsupportedTargetError(
            "inspect_dart_aot",
            path,
            "No Dart snapshot symbols were found in the dynamic symbol table; the payload does not carry a recognizable AOT layout",
          ),
        );
      const pool = projectStringPool(isolateData);
      const partial =
        sections.length < symbolNames.length ||
        sections.some((section) => !section.magic_valid) ||
        pool.packageUriCount > MAX_POOL_URIS ||
        pool.dartUriCount > MAX_POOL_URIS ||
        pool.classLikeTokenCount > MAX_POOL_TOKENS;
      return ok(
        createAnalysisExecution(
          {
            target: { path, bytes: info.size, sha256 },
            abi: selected.abi,
            libapp: {
              bytes: total,
              sha256: imageSha256,
              snapshot_hash:
                hashScan.candidates.length === 1
                  ? hashScan.candidates[0]!
                  : null,
              sections,
            },
            string_pool: {
              package_uris: pool.packageUris.slice(0, MAX_POOL_URIS),
              package_uri_count: pool.packageUriCount,
              dart_uris: pool.dartUris.slice(0, MAX_POOL_URIS),
              dart_uri_count: pool.dartUriCount,
              class_like_tokens: pool.classLikeTokens.slice(0, MAX_POOL_TOKENS),
              class_like_token_count: pool.classLikeTokenCount,
              printable_run_count: pool.printableRunCount,
            },
            coverage: partial ? "partial" : "complete",
          },
          FLUTTER_PROVIDER_IDENTITY,
          {
            limitations: [
              "Snapshot sections are located through the ELF dynamic symbol table; a payload without exported snapshot symbols is refused rather than guessed",
              "String-pool entries are byte-pattern observations from the isolate data section, not deserialized cluster semantics; typed class and function recovery needs an SDK-specific parser",
              "class_like_tokens are identifier-shaped runs and include incidental matches",
              ...(sections.length < symbolNames.length
                ? [
                    `Only ${String(sections.length)} of 4 snapshot symbols were present`,
                  ]
                : []),
              ...(pool.packageUriCount > MAX_POOL_URIS
                ? [
                    `package_uris reports the first ${String(MAX_POOL_URIS)} of ${String(pool.packageUriCount)} distinct URIs`,
                  ]
                : []),
              ...(pool.classLikeTokenCount > MAX_POOL_TOKENS
                ? [
                    `class_like_tokens reports the first ${String(MAX_POOL_TOKENS)} of ${String(pool.classLikeTokenCount)} distinct tokens`,
                  ]
                : []),
            ],
          },
        ),
      );
    } finally {
      await reader.close().catch(() => undefined);
    }
  }
}

/** Categorize printable runs from one snapshot data section. */
const projectStringPool = (
  section: Buffer | null,
): {
  packageUris: string[];
  packageUriCount: number;
  dartUris: string[];
  dartUriCount: number;
  classLikeTokens: string[];
  classLikeTokenCount: number;
  printableRunCount: number;
} => {
  const packages = new Set<string>();
  const darts = new Set<string>();
  const tokens = new Set<string>();
  let runCount = 0;
  if (section !== null) {
    let run = "";
    const consider = (text: string): void => {
      if (text.length < 6) return;
      runCount += 1;
      if (text.startsWith("package:")) packages.add(text);
      else if (text.startsWith("dart:")) darts.add(text);
      else if (
        text.length <= 128 &&
        text.length >= 5 &&
        IDENTIFIER_PATTERN.test(text)
      )
        tokens.add(text);
    };
    for (const byte of section) {
      if (byte >= 0x20 && byte < 0x7f) run += String.fromCharCode(byte);
      else {
        consider(run);
        run = "";
      }
    }
    consider(run);
  }
  return {
    packageUris: [...packages].sort(),
    packageUriCount: packages.size,
    dartUris: [...darts].sort(),
    dartUriCount: darts.size,
    classLikeTokens: [...tokens].sort(),
    classLikeTokenCount: tokens.size,
    printableRunCount: runCount,
  };
};
