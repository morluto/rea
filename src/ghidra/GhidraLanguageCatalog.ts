import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeLimit,
  malformedInput,
  ParseFailureError,
} from "../domain/parseFailure.js";
import { GhidraAdmissionError } from "./GhidraAdmissionError.js";
import { parseXmlDocument } from "../domain/xmlDocument.js";
import { decodeXmlPlistText } from "../domain/propertyListXmlText.js";

import {
  ArtifactFileFailureGroup,
  ArtifactReaderFailure,
  type ArtifactResourceScope,
  artifactPrimaryCleanupLeases,
  assertArtifactReadActive,
  withArtifactRegularFile,
} from "../resources/index.js";
import type { GhidraLanguageOverride } from "../config/ghidraLanguageOverride.js";
import type { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { parseLimitConstraint } from "../domain/parseFailureAnalysisError.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { RegularFileOperationCancelled } from "../filesystem/RegularFile.js";
import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";

/** One language definition and the compiler specs it declares. */
export interface GhidraLanguageDefinition {
  readonly id: string;
  readonly compilerSpecIds: readonly string[];
}

interface GhidraLanguageCatalog {
  readonly definitions: readonly GhidraLanguageDefinition[];
  readonly oversizedFiles: readonly string[];
}

// Language definitions are small XML files; refuse anything implausibly large.
const MAX_LDEFS_BYTES = 4 * 1024 * 1024;
// Processor modules ship under Processors; installed extensions may add more.
const LANGUAGE_ROOTS = ["Ghidra/Processors", "Ghidra/Extensions"] as const;
const CATALOG_CONCURRENCY = 8;

/** Parse the `<language>` elements of one `.ldefs` document. */
const parseGhidraLanguageDefinitions = (
  text: string,
): readonly GhidraLanguageDefinition[] => {
  const definitions: GhidraLanguageDefinition[] = [];
  const parsed = parseXmlDocument(text, {
    doctype: "allow",
    lineEndings: "normalize",
  });
  if (!parsed.ok) throw parsed.error;
  const document = parsed.value;
  const root = document.documentElement;
  if (root?.tagName !== "language_definitions")
    throw malformedInput(
      "ghidra-language-definition",
      "Expected Ghidra language_definitions XML root",
    );
  for (const language of Array.from(root.getElementsByTagName("language"))) {
    if (language.parentNode !== root) continue;
    const id = language.getAttribute("id");
    if (id === null) continue;
    const compilerSpecIds: string[] = [];
    for (const compiler of Array.from(
      language.getElementsByTagName("compiler"),
    )) {
      if (compiler.parentNode !== language) continue;
      const compilerId = compiler.getAttribute("id");
      if (compilerId !== null) compilerSpecIds.push(compilerId);
    }
    definitions.push({ id, compilerSpecIds });
  }
  return definitions;
};

const languageDirectories = async (
  installDir: string,
  signal: AbortSignal | undefined,
): Promise<string[]> => {
  const directories: string[] = [];
  for (const root of LANGUAGE_ROOTS) {
    assertArtifactReadActive(signal);
    let modules: string[];
    try {
      modules = await readdir(join(installDir, root));
    } catch (cause: unknown) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        continue;
      throw cause;
    }
    for (const module of modules.sort())
      directories.push(join(installDir, root, module, "data", "languages"));
  }
  return directories;
};

/**
 * Parse one definition before its final close. An oversized file remains
 * unexamined. The caller's scope owns a descriptor whose close is unconfirmed.
 */
const readLanguageDefinitionFile = (
  path: string,
  resources: ArtifactResourceScope,
  signal: AbortSignal | undefined,
): Promise<readonly GhidraLanguageDefinition[] | undefined> =>
  withArtifactRegularFile(
    path,
    resources,
    signal,
    async ({ handle: file }) => {
      const bytes = await readBoundedFileBytes(file, MAX_LDEFS_BYTES, {
        signal,
        cancellationFailure: (reason) =>
          new RegularFileOperationCancelled(reason),
      });
      // The XML byte owner validates encoding and declaration before syntax
      // parsing; a literal U+FFFD cannot diagnose invalid source bytes.
      if (bytes === undefined) return undefined;
      try {
        return parseGhidraLanguageDefinitions(decodeXmlPlistText(bytes));
      } catch (cause: unknown) {
        if (!(cause instanceof ParseFailureError)) throw cause;
        throw new GhidraAdmissionError(
          "language_definition_invalid",
          { path, parse_kind: cause.kind, parse_message: cause.message },
          { cause },
        );
      }
    },
    "follow",
  );

const mergeCatalogFailures = (
  failures: readonly { readonly index: number; readonly cause: unknown }[],
): unknown => {
  const ordered = [...failures].sort((left, right) => left.index - right.index);
  const primary = ordered[0]!.cause;
  const siblingCleanups = ordered
    .slice(1)
    .flatMap(({ cause }) =>
      cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined
        ? [cause]
        : [],
    );
  if (siblingCleanups.length === 0) return primary;
  const primaryLeases = artifactPrimaryCleanupLeases(primary);
  const siblingLeases = siblingCleanups.map(artifactPrimaryCleanupLeases);
  const cleanupLeases =
    primaryLeases === undefined || siblingLeases.includes(undefined)
      ? undefined
      : [
          ...new Set([
            ...primaryLeases,
            ...siblingLeases.flatMap((leases) => leases ?? []),
          ]),
        ];
  return new ArtifactFileFailureGroup(
    primary,
    {
      reason: siblingCleanups.map(({ cleanup }) => cleanup!.reason).join("; "),
      resources: [
        ...new Set(
          siblingCleanups.flatMap(({ cleanup }) => cleanup!.resources),
        ),
      ],
    },
    cleanupLeases,
  );
};

const runBoundedWorkers = async (
  count: number,
  concurrency: number,
  work: (index: number) => Promise<void>,
): Promise<void> => {
  if (count === 0) return;
  let nextIndex = 0;
  let stopped = false;
  const failures: Array<{ readonly index: number; readonly cause: unknown }> =
    [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, count) }, async () => {
      while (!stopped) {
        const index = nextIndex++;
        if (index >= count) return;
        try {
          await work(index);
        } catch (cause: unknown) {
          stopped = true;
          failures.push({ index, cause });
          return;
        }
      }
    }),
  );
  if (failures.length > 0) throw mergeCatalogFailures(failures);
};

const discoverLanguageDefinitionFiles = async (
  directories: readonly string[],
  signal: AbortSignal | undefined,
): Promise<string[]> => {
  const slots: string[][] = Array.from(
    { length: directories.length },
    () => [],
  );
  await runBoundedWorkers(
    directories.length,
    CATALOG_CONCURRENCY,
    async (index) => {
      assertArtifactReadActive(signal);
      const directory = directories[index]!;
      let entries: string[];
      try {
        entries = await readdir(directory);
      } catch (cause: unknown) {
        // A module may contain no language directory; inability to read one is not absence.
        if (
          cause instanceof Error &&
          "code" in cause &&
          (cause.code === "ENOENT" || cause.code === "ENOTDIR")
        )
          return;
        throw cause;
      }
      const ldefs: string[] = [];
      for (const entry of entries.sort())
        if (entry.endsWith(".ldefs")) ldefs.push(join(directory, entry));
      slots[index] = ldefs;
    },
  );
  return slots.flat();
};

/**
 * Read every language definition shipped by one Ghidra installation. Admission
 * first retries cleanup the scope retains, so an unconfirmed close blocks reads
 * only until that exact owner releases.
 */
export const readGhidraLanguageCatalog = (
  installDir: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<GhidraLanguageCatalog> =>
  resources.run(async () => {
    const directories = await languageDirectories(installDir, signal);
    const files = await discoverLanguageDefinitionFiles(directories, signal);
    // An empty scan starts no definition reads that could observe cancellation.
    assertArtifactReadActive(signal);
    const results = new Array<readonly GhidraLanguageDefinition[] | undefined>(
      files.length,
    );
    await runBoundedWorkers(
      files.length,
      CATALOG_CONCURRENCY,
      async (index) => {
        results[index] = await readLanguageDefinitionFile(
          files[index]!,
          resources,
          signal,
        );
      },
    );
    return {
      definitions: results.flatMap((result) => result ?? []),
      oversizedFiles: files.filter((_, index) => results[index] === undefined),
    };
  });

/**
 * Check a configured import language against the installation before launch,
 * returning a configuration error for a missing ID only after a complete scan.
 */
export const admitGhidraLanguageOverride = (
  override: GhidraLanguageOverride,
  catalog: GhidraLanguageCatalog,
  providerVersion: string,
): ConfigurationError | AnalysisResourceConstraintError | null => {
  const language = catalog.definitions.find(
    (value) => value.id === override.languageId,
  );
  if (language === undefined) {
    const path = catalog.oversizedFiles[0];
    if (path !== undefined)
      return parseLimitConstraint(
        "resolve_analysis_profile",
        "file-size",
        decodeLimit(
          "ghidra-language-definition",
          "The configured Ghidra language could not be confirmed because installed language definitions exceeded the size limit.",
          { name: "language_definition_bytes", maximum: MAX_LDEFS_BYTES },
        ),
        {
          diagnostics: {
            path,
            oversized_definition_count: catalog.oversizedFiles.length,
            setting: "REA_GHIDRA_LANGUAGE_ID",
          },
          retryable: false,
          remediationAction:
            "Use a Ghidra installation whose language definitions fit the reported size limit.",
        },
      );
    return new ConfigurationError("Invalid REA environment configuration", {
      settings: [
        {
          setting: "REA_GHIDRA_LANGUAGE_ID",
          constraint: `is not a language defined by Ghidra ${providerVersion}`,
        },
      ],
    });
  }
  if (
    override.compilerSpecId !== undefined &&
    !language.compilerSpecIds.includes(override.compilerSpecId)
  )
    return new ConfigurationError("Invalid REA environment configuration", {
      settings: [
        {
          setting: "REA_GHIDRA_COMPILER_SPEC_ID",
          constraint: `must be one of the selected language's compiler specs: ${language.compilerSpecIds.join(", ")}`,
        },
      ],
    });
  return null;
};
