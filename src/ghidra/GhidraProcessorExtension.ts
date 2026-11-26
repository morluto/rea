import { GhidraAdmissionError } from "./GhidraAdmissionError.js";
import { createHash } from "node:crypto";
import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";
import { z } from "zod";
import { sameRegularFileState } from "../filesystem/RegularFile.js";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  classifyProviderFailure,
  type ProviderFailureDialect,
} from "../providers/classifyProviderFailure.js";
import { err, ok, type Result } from "../domain/result.js";
import type { GhidraInstallationInspection } from "./GhidraInstallation.js";
import { parseGhidraJavaProperties } from "./GhidraJavaProperties.js";

import {
  type ArtifactResourceScope,
  ArtifactReaderFailure,
  AnalysisCleanupLease,
  assertArtifactReadActive,
  artifactFilePrimaryFacts,
  withArtifactRegularFile,
} from "../resources/index.js";
import { OwnedDirectoryHandle } from "../filesystem/OwnedDirectoryHandle.js";
import { errorMessage } from "../kernel/errorMessage.js";

/** Installed processor code and data, distinct from REA's analysis-extension ABI. */
export const ghidraProcessorExtensionSchema = <Id extends string>(id: Id) =>
  z.strictObject({
    id: z.literal(id),
    root: z.string().refine(isAbsolute),
    ghidra_version: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  });
export interface GhidraProcessorExtension<Id extends string = string> {
  readonly id: Id;
  readonly root: string;
  readonly ghidra_version: string;
  readonly sha256: string;
}

/**
 * A compiled SLEIGH language Ghidra must load as installed. See
 * docs/providers/ghidra-ps2.md#precompiled-sleigh-language for the rule it mirrors.
 */
export interface GhidraCompiledLanguageSpec {
  readonly source: string;
  readonly compiled: string;
}

/** One caller-installed processor extension REA fingerprints but never installs. */
export interface GhidraProcessorExtensionSpec<Id extends string = string> {
  /** Directory and extension.properties name under Ghidra/Extensions. */
  readonly id: Id;
  /** Profile name used in cancellation messages. */
  readonly profile: string;
  readonly unavailableCode: string;
  readonly required: readonly string[];
  readonly compiledLanguage?: GhidraCompiledLanguageSpec;
}

// Resource bounds for scanning a caller-installed extension, not target limits.
const MAX_ENTRIES = 1024;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 16;
// Ghidra 12.2 SlaFormat: "sla" followed by FORMAT_VERSION 4.
const SLA_MAGIC = Buffer.from("sla", "latin1");
const SLA_FORMAT_VERSION = 4;

interface InstalledFile {
  /** Java `File.lastModified()` resolution: whole milliseconds. */
  readonly modifiedMs: number;
  readonly bytes?: Buffer;
}

/** Read-only fingerprint of all installed files; no home scanning or installation. */
export const inspectGhidraProcessorExtension = async <Id extends string>(
  spec: GhidraProcessorExtensionSpec<Id>,
  root: string,
  ghidraVersion: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<GhidraProcessorExtension<Id>> => {
  try {
    return await resources.run(() =>
      fingerprint(spec, root, ghidraVersion, resources, signal),
    );
  } catch (cause: unknown) {
    throw classifyProviderFailure(cause, inspectionDialect(spec));
  }
};

const fingerprint = async <Id extends string>(
  spec: GhidraProcessorExtensionSpec<Id>,
  root: string,
  ghidraVersion: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<GhidraProcessorExtension<Id>> => {
  assertArtifactReadActive(signal);
  if (!isAbsolute(root) || (await realpath(root)) !== root)
    throw new GhidraAdmissionError("canonical_path");
  const files: string[] = [];
  let entries = 1; // The root itself consumes one inventory entry.
  const visit = async (relative: string, depth: number): Promise<void> => {
    assertArtifactReadActive(signal);
    if (depth > MAX_DEPTH)
      throw new GhidraAdmissionError("nesting_exceeds_limit", {
        max_depth: MAX_DEPTH,
      });
    const path = join(root, relative);
    const metadata = await lstat(path);
    if (metadata.isDirectory()) {
      const children = await readChildren(
        spec,
        path,
        MAX_ENTRIES - entries,
        resources,
        signal,
      );
      entries += children.length;
      children.sort();
      for (const child of children)
        await visit(
          relative === "" ? child : `${relative}/${child}`,
          depth + 1,
        );
    } else if (metadata.isFile()) {
      files.push(relative);
    } else throw new GhidraAdmissionError("entry_kind", { relative });
  };
  await visit("", 0);
  for (const required of spec.required)
    if (!files.includes(required))
      throw new GhidraAdmissionError("component_missing", {
        component: required,
      });
  if (!files.some((path) => path.startsWith("lib/") && path.endsWith(".jar")))
    throw new GhidraAdmissionError("loader_jar_missing");
  const retainBytes = (relative: string): boolean =>
    relative === "extension.properties" ||
    (spec.compiledLanguage !== undefined &&
      (relative === spec.compiledLanguage.compiled ||
        relative.endsWith(".slaspec") ||
        relative.endsWith(".sinc")));
  const installed = new Map<string, InstalledFile>();
  const hash = createHash("sha256");
  let bytesRead = 0;
  for (const relative of files) {
    assertArtifactReadActive(signal);
    const path = join(root, relative);
    await withArtifactRegularFile(
      path,
      resources,
      signal,
      async ({ handle, initial: before }) => {
        if (
          !Number.isSafeInteger(before.size) ||
          before.size > MAX_BYTES - bytesRead
        )
          throw new GhidraAdmissionError("bytes_exceed_limit", {
            max_bytes: MAX_BYTES,
          });
        if (relative === "extension.properties" && before.size > 65536)
          throw new GhidraAdmissionError("properties_exceed_limit", {
            max_bytes: 65536,
          });
        hash.update(JSON.stringify([relative, before.size]));
        const buffer = Buffer.alloc(Math.min(65536, before.size + 1));
        let offset = 0;
        const chunks: Buffer[] = [];
        const retain = retainBytes(relative);
        // Serial reads keep final close behind every native read. One extra byte
        // detects growth without a stream's read-ahead or unbounded allocation.
        while (offset <= before.size) {
          assertArtifactReadActive(signal);
          const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, before.size - offset + 1),
            offset,
          );
          assertArtifactReadActive(signal);
          if (bytesRead === 0) break;
          offset += bytesRead;
          if (offset > before.size)
            throw new GhidraAdmissionError("component_changed", { relative });
          const chunk = buffer.subarray(0, bytesRead);
          hash.update(chunk);
          if (retain) chunks.push(Buffer.from(chunk));
        }
        if (offset !== before.size)
          throw new GhidraAdmissionError("component_truncated", { relative });
        if (
          !sameRegularFileState(before, await handle.stat()) ||
          !sameRegularFileState(before, await lstat(path))
        )
          throw new GhidraAdmissionError("component_changed", { relative });
        bytesRead += before.size;
        installed.set(relative, {
          modifiedMs: Math.trunc(before.mtimeMs),
          ...(retain ? { bytes: Buffer.concat(chunks) } : {}),
        });
      },
    );
  }
  // Ghidra's extension.properties version is the compatible Ghidra version,
  // not the extension release (e.g. v21.4); content identity supplies the latter.
  const parsedProperties = parseGhidraJavaProperties(
    (installed.get("extension.properties")?.bytes ?? Buffer.alloc(0)).toString(
      "latin1",
    ),
  );
  if (!parsedProperties.ok)
    throw new GhidraAdmissionError("properties_invalid", {
      parser_code: parsedProperties.error,
    });
  const property = (name: string): string | undefined =>
    parsedProperties.value.get(name);
  if (property("name") !== spec.id || property("version") !== ghidraVersion)
    throw new GhidraAdmissionError("metadata_mismatch", {
      ghidra_version: ghidraVersion,
    });
  if (spec.compiledLanguage !== undefined)
    validateCompiledLanguage(spec.compiledLanguage, installed);
  assertArtifactReadActive(signal);
  return {
    id: spec.id,
    root,
    ghidra_version: ghidraVersion,
    sha256: hash.digest("hex"),
  };
};

/**
 * Refuse a compiled language that Ghidra's SleighLanguageFile.needsCompilation
 * would rebuild inside the installation: missing, another SLA format, or older
 * than its source and every file the source includes.
 */
const validateCompiledLanguage = (
  language: GhidraCompiledLanguageSpec,
  installed: ReadonlyMap<string, InstalledFile>,
): void => {
  const compiled = installed.get(language.compiled);
  if (compiled?.bytes === undefined)
    throw new GhidraAdmissionError("compiled_language_missing", {
      component: language.compiled,
    });
  const header = compiled.bytes;
  const format =
    header.length >= 4 && header.subarray(0, 3).equals(SLA_MAGIC)
      ? header[3]
      : undefined;
  if (format !== SLA_FORMAT_VERSION)
    throw new GhidraAdmissionError("compiled_language_format", {
      component: language.compiled,
      required_format: SLA_FORMAT_VERSION,
      ...(format === undefined ? {} : { observed_format: format }),
    });
  for (const source of sleighSourceClosure(language.source, installed)) {
    const modifiedMs = installed.get(source)?.modifiedMs;
    if (
      compiled.modifiedMs === 0 ||
      modifiedMs === undefined ||
      modifiedMs > compiled.modifiedMs
    )
      throw new GhidraAdmissionError("compiled_language_stale", {
        component: language.compiled,
        source,
      });
  }
};

// Ghidra 12.2 SleighPreprocessor's include directive.
const INCLUDE = /^\s*@include\s+"(.*)"\s*$/u;

/**
 * The source and every file it can include. Conditional directives are not
 * evaluated, so an inactive branch's include also counts; that can only refuse
 * more. Includes Ghidra would resolve outside this inventory are unresolved.
 */
const sleighSourceClosure = (
  source: string,
  installed: ReadonlyMap<string, InstalledFile>,
): readonly string[] => {
  const closure = new Set<string>();
  const active: string[] = [];
  const visit = (relative: string): void => {
    if (active.includes(relative))
      throw new GhidraAdmissionError("compiled_language_source_unresolved", {
        source: relative,
        reason: "include_cycle",
      });
    if (closure.has(relative)) return;
    const bytes = installed.get(relative)?.bytes;
    if (bytes === undefined)
      throw new GhidraAdmissionError("compiled_language_source_unresolved", {
        source: relative,
        reason: "not_installed",
      });
    closure.add(relative);
    active.push(relative);
    for (const raw of bytes.toString("latin1").split(/\r\n|\r|\n/u)) {
      const line = raw.replace(/^\s*#.*/u, "");
      if (!line.startsWith("@")) continue;
      const include = INCLUDE.exec(line.replace(/#.*/u, ""))?.[1];
      if (include === undefined) continue;
      if (
        include.includes("$(") ||
        include.startsWith("/") ||
        include.startsWith("\\") ||
        /^[a-zA-Z_0-9]+:/u.test(include)
      )
        throw new GhidraAdmissionError("compiled_language_source_unresolved", {
          source: relative,
          include,
          reason: "outside_inventory",
        });
      const resolved = posix.normalize(
        posix.join(posix.dirname(relative), include),
      );
      if (resolved === ".." || resolved.startsWith("../"))
        throw new GhidraAdmissionError("compiled_language_source_unresolved", {
          source: relative,
          include,
          reason: "outside_inventory",
        });
      visit(resolved);
    }
    active.pop();
  };
  visit(source);
  return [...closure];
};

/** Resolve prerequisites before opening or admitting cached extension-lane analysis. */
export const resolveGhidraProcessorExtension = async <Id extends string>(
  spec: GhidraProcessorExtensionSpec<Id>,
  installation: GhidraInstallationInspection,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<Result<GhidraProcessorExtension<Id>, AnalysisError>> => {
  try {
    assertArtifactReadActive(signal);
    if (
      installation.status !== "available" ||
      installation.platform !== "linux" ||
      installation.architecture !== "x64"
    )
      throw new GhidraAdmissionError("host_unsupported", {
        platform: installation.platform,
        architecture: installation.architecture,
      });
    const root = join(
      await realpath(installation.installDir),
      "Ghidra",
      "Extensions",
      spec.id,
    );
    return ok(
      await inspectGhidraProcessorExtension(
        spec,
        root,
        installation.providerVersion,
        resources,
        signal,
      ),
    );
  } catch (cause: unknown) {
    return err(classifyProviderFailure(cause, inspectionDialect(spec)));
  }
};

const COMPILED_LANGUAGE_CODES: ReadonlySet<string> = new Set([
  "compiled_language_missing",
  "compiled_language_format",
  "compiled_language_stale",
  "compiled_language_source_unresolved",
]);

/**
 * How a failed extension inspection is reported. The shared classifier keeps
 * typed failures, a cancelled read and the read's live cleanup; anything else
 * means no compatible caller-installed extension was established.
 */
const inspectionDialect = (
  spec: GhidraProcessorExtensionSpec,
): ProviderFailureDialect => ({
  providerId: "ghidra",
  operation: "resolve_analysis_profile",
  unclassified: (cause, details) => {
    const { cause: primary } = artifactFilePrimaryFacts(cause);
    const admission =
      primary instanceof GhidraAdmissionError ? primary : undefined;
    const identity = admission?.code ?? errorMessage(primary);
    const remedy =
      spec.compiledLanguage !== undefined &&
      admission !== undefined &&
      COMPILED_LANGUAGE_CODES.has(admission.code)
        ? `Precompile ${spec.compiledLanguage.compiled} from ${spec.compiledLanguage.source} with the selected installation's support/sleigh before analysis; Ghidra would otherwise recompile it inside the installation, and REA does not compile or install it.`
        : `Use a compatible caller-installed ${spec.id} under GHIDRA_INSTALL_DIR/Ghidra/Extensions; REA does not install it.`;
    const reason = `${spec.unavailableCode}: ${identity} ${remedy}`;
    return new AnalysisCapabilityUnavailableError(
      "ghidra",
      "resolve_analysis_profile",
      reason,
      {
        ...details,
        cause,
        userMessage: reason,
        ...(admission === undefined
          ? {}
          : { diagnostics: { code: admission.code, ...admission.detail } }),
      },
    );
  },
});

/** Close before descending, retaining the exact directory owner on uncertainty. */
const readChildren = async (
  spec: GhidraProcessorExtensionSpec,
  path: string,
  remainingEntries: number,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<string[]> => {
  assertArtifactReadActive(signal);
  const owner = new OwnedDirectoryHandle(await opendir(path));
  let outcome:
    | { readonly kind: "completed"; readonly names: string[] }
    | { readonly kind: "failed"; readonly cause: unknown };
  try {
    const names: string[] = [];
    for (;;) {
      assertArtifactReadActive(signal);
      const child = await owner.handle.read();
      assertArtifactReadActive(signal);
      if (child === null) break;
      if (names.length >= remainingEntries)
        throw new GhidraAdmissionError("inventory_exceeds_limit", {
          max_entries: MAX_ENTRIES,
        });
      names.push(child.name);
    }
    outcome = { kind: "completed", names };
  } catch (cause: unknown) {
    outcome = { kind: "failed", cause };
  }
  const lease = new AnalysisCleanupLease(() => owner.close(), [path]);
  const attempt = await resources.release({
    kind: "lease",
    resource: path,
    lease,
  });
  if (attempt.kind === "failed") {
    const primary =
      outcome.kind === "failed"
        ? outcome.cause
        : signal?.aborted
          ? new ArtifactReaderFailure(
              "cancelled",
              `${spec.profile} inspection cancelled during directory close`,
              { cause: signal.reason },
            )
          : attempt.cause;
    const error = classifyProviderFailure(
      ArtifactReaderFailure.withCleanup(
        primary,
        ArtifactReaderFailure.cleanupObservation(attempt.cause, path),
      ),
      inspectionDialect(spec),
    );
    lease.bindCleanupError(error);
    throw error;
  }
  if (outcome.kind === "failed") throw outcome.cause;
  assertArtifactReadActive(signal);
  return outcome.names;
};
