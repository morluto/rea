import { Readable, Transform, pipeline } from "node:stream";
import { finished } from "node:stream/promises";
import { setImmediate } from "node:timers/promises";

import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import { artifactExpansionBudgetBytes } from "../domain/artifactExpansionBudget.js";
import { fixedAllowanceRemediation } from "../domain/fixedAllowanceRemediation.js";
import type {
  DenoStandaloneEntryMetadata,
  DenoStandaloneMetadata,
} from "../domain/artifactFormatMetadata.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";
import { assertArtifactReadActive } from "./ArtifactFileOperation.js";
import { ArtifactFileSource } from "./ArtifactFileSource.js";
import {
  ArtifactPathRegistry,
  normalizeArtifactPath,
} from "./ArtifactPaths.js";
import {
  ArtifactReaderFailure,
  copyArtifactEntry,
  sameArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactTraversalOptions,
} from "./ArtifactReader.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import type { DenoStandaloneAdmission } from "./deno/DenoStandaloneAdmission.js";
import {
  denoFormatFailure,
  denoMediaTypeName,
  parseDenoSection,
  type DenoByteRange,
  type DenoParsedSection,
  type DenoRemoteModule,
} from "./deno/DenoSectionLayout.js";
import { locateDenoStandalone } from "./deno/DenoStandaloneLocation.js";
import {
  DENO_CHILD_SUFFIXES,
  DENO_PATH_LENGTH_LIMITATION,
  denoLogicalPathFits,
  MAX_DENO_LOGICAL_PATH_PARTS,
  type DenoVfsMember,
} from "./deno/DenoVirtualFs.js";

const MAX_DENO_LOGICAL_PATH_NODES = 250_000;
const UNLISTED_VFS_LIMITATION =
  "The Deno compile virtual filesystem could not be listed, so its files are not inventoried.";
/** Characters a Windows destination refuses in a generated path. */
const NON_PORTABLE_PATH_CHARACTERS = /[:\\\u0001-\u001f]/gu;
export const MAX_DENO_RETAINED_BYTES = 256 * 1024 * 1024;

interface RemoteDestination {
  readonly path: string;
  readonly sourcePath: string | null;
  readonly limitations: readonly string[];
}

/** One descriptor and bounded reads of an embedded Deno compile section. */
export class DenoStandaloneArtifactReader implements ArtifactReader {
  readonly format = "deno-standalone" as const;
  readonly #scope = new ArtifactResourceScope();
  readonly #entries = new Map<string, ArtifactEntry>();
  readonly #streams = new Set<Readable>();
  readonly #source: ArtifactFileSource;
  #admission: DenoStandaloneAdmission | undefined;
  #prepared: Promise<void> | undefined;
  #header: DenoStandaloneMetadata | undefined;
  #closing = false;

  constructor(
    path: string,
    admitted?: StableRegularFileDescriptor | DenoStandaloneAdmission,
  ) {
    if (admitted !== undefined && "kind" in admitted) {
      this.#admission = admitted;
      this.#source = new ArtifactFileSource(
        path,
        "Deno compile",
        admitted.source,
      );
    } else
      this.#source = new ArtifactFileSource(path, "Deno compile", admitted);
  }

  formatMetadata(): DenoStandaloneMetadata | undefined {
    return this.#header === undefined ? undefined : { ...this.#header };
  }

  async prepareContainer(
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#scope.run(async () => {
      this.#assertOpen(signal);
      await this.#source.bindSelectedPathSha256(expectedSha256, signal);
    });
  }

  async *entries(
    signal?: AbortSignal,
    options?: ArtifactTraversalOptions,
  ): AsyncIterable<ArtifactEntry> {
    await this.#scope.run(async () => {
      this.#assertOpen(signal);
      this.#prepared ??= this.#prepare(signal);
      await this.#prepared;
      await this.#source.readSelectedPath(signal);
    });
    if (this.#header?.vfs_listing === "unsupported")
      options?.onCoverage?.({
        status: "unknown",
        limitations: [UNLISTED_VFS_LIMITATION],
      });
    let index = 0;
    for (const entry of this.#entries.values()) {
      if (index++ % 256 === 0) await setImmediate();
      this.#assertOpen(signal);
      yield copyArtifactEntry(entry);
    }
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      this.#assertOpen(signal);
      const stored = this.#entries.get(entry.adapterKey);
      if (stored === undefined || !sameArtifactEntry(entry, stored))
        throw new ArtifactReaderFailure(
          "integrity",
          "Deno compile entry does not match its owning inventory",
        );
      const { handle } = await this.#source.readSelectedPath(signal);
      this.#assertOpen(signal);
      if (stored.byteOffset === null || stored.declaredSize === null)
        throw denoFormatFailure("member has no physical byte range");
      const source =
        stored.declaredSize === 0
          ? Readable.from([])
          : readFileHandleChunks(handle, {
              start: stored.byteOffset,
              end: stored.byteOffset + stored.declaredSize - 1,
              signal,
              cancellationFailure: (reason) =>
                new ArtifactReaderFailure(
                  "cancelled",
                  "Deno compile read cancelled",
                  {
                    cause: reason,
                  },
                ),
            });
      const output = memberStream(stored);
      output.on("error", () => undefined);
      this.#streams.add(output);
      output.once("close", () => this.#streams.delete(output));
      void this.#scope
        .run(
          () =>
            new Promise<void>((resolve) => {
              pipeline(source, output, () => {
                resolve();
              });
            }),
        )
        .catch((cause: unknown) =>
          output.destroy(
            cause instanceof Error
              ? cause
              : new Error("Deno compile stream ownership failed", { cause }),
          ),
        );
      return output;
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const stream of this.#streams)
      stream.destroy(
        new ArtifactReaderFailure("unavailable", "Deno compile reader closed"),
      );
    await this.#scope.close();
    await Promise.all(
      [...this.#streams].map((stream) =>
        finished(stream).catch(() => undefined),
      ),
    );
    await this.#source.close();
    this.#entries.clear();
    this.#header = undefined;
    this.#admission = undefined;
    this.#prepared = undefined;
  }

  provenance(): readonly [] {
    return [];
  }

  #assertOpen(signal?: AbortSignal): void {
    assertArtifactReadActive(signal);
    if (this.#closing)
      throw new ArtifactReaderFailure(
        "unavailable",
        "Deno compile reader is closed",
      );
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const source = await this.#source.readSelectedPath(signal);
    const probe =
      this.#admission?.probe ??
      (await locateDenoStandalone(source.handle, source.initial.size, signal));
    if (probe.status === "absent")
      throw denoFormatFailure("no Deno compile section");
    if ("failure" in probe) throw probe.failure;
    const location = probe.location;
    const section = await parseDenoSection(
      location.length,
      async (offset, length) => {
        const bytes = Buffer.alloc(length);
        let filled = 0;
        while (filled < length) {
          assertArtifactReadActive(signal);
          const read = await source.handle.read(
            bytes,
            filled,
            length - filled,
            location.offset + offset + filled,
          );
          assertArtifactReadActive(signal);
          if (read.bytesRead === 0)
            throw denoFormatFailure("section read was short");
          filled += read.bytesRead;
        }
        return bytes;
      },
      signal,
    );
    const header = sectionHeader(location, section);
    let retainedBytes = jsonValueByteLength(
      header as JsonValue,
      MAX_DENO_RETAINED_BYTES,
    );
    if (retainedBytes > MAX_DENO_RETAINED_BYTES)
      throw denoRetainedLimit(retainedBytes);
    let declaredPlaintext = 0n;
    const expansionBudget = BigInt(
      artifactExpansionBudgetBytes(location.length),
    );
    const paths = new ArtifactPathRegistry({
      maxParts: MAX_DENO_LOGICAL_PATH_PARTS,
      maxNodes: MAX_DENO_LOGICAL_PATH_NODES,
    });
    const admit = (entry: ArtifactEntry): void => {
      if (entry.declaredSize !== null) {
        declaredPlaintext += BigInt(entry.declaredSize);
        if (declaredPlaintext > expansionBudget)
          throw new ArtifactReaderFailure(
            "limit",
            `Deno compile readable entries declare ${String(declaredPlaintext)} plaintext bytes, exceeding this section's ${String(expansionBudget)}-byte expansion budget. This release has no runtime override. Host memory and NODE_OPTIONS do not raise it.`,
            { boundary: "capacity" },
          );
      }
      paths.reservePath(entry.path);
      retainedBytes += jsonValueByteLength(
        (entry.formatMetadata ?? null) as JsonValue,
        Math.max(0, MAX_DENO_RETAINED_BYTES - retainedBytes),
      );
      if (retainedBytes > MAX_DENO_RETAINED_BYTES)
        throw denoRetainedLimit(retainedBytes);
      this.#entries.set(entry.adapterKey, entry);
    };
    if (section.vfs.listing === "listed") {
      for (const member of section.vfs.members) {
        assertArtifactReadActive(signal);
        admit(vfsEntry(location.offset, section, member));
      }
    }
    const remotePlans = assignRemoteDestinations(section, paths);
    for (const module of section.remoteModules.modules) {
      assertArtifactReadActive(signal);
      const destination = remotePlans.get(module.index);
      if (destination === undefined) continue;
      for (const entry of remoteEntries(
        location.offset,
        section,
        module,
        destination,
      ))
        admit(entry);
    }
    await this.#source.readSelectedPath(signal);
    this.#assertOpen(signal);
    this.#header = header;
    this.#admission = undefined;
  }
}

const sectionHeader = (
  location: {
    readonly carrier: DenoStandaloneMetadata["carrier"];
    readonly embedding: DenoStandaloneMetadata["embedding"];
    readonly offset: number;
    readonly length: number;
  },
  section: DenoParsedSection,
): DenoStandaloneMetadata => ({
  kind: "deno-standalone",
  carrier: location.carrier,
  embedding: location.embedding,
  section_offset: location.offset,
  section_length: location.length,
  entrypoint_key: section.metadata.entrypointKey,
  argv: section.metadata.argv === null ? null : [...section.metadata.argv],
  v8_flags:
    section.metadata.v8Flags === null ? null : [...section.metadata.v8Flags],
  permissions: section.metadata.permissions,
  unstable_config: section.metadata.unstableConfig,
  app_name: section.metadata.appName,
  self_extracting: section.metadata.selfExtracting,
  npm_snapshot_byte_length: section.npmSnapshotByteLength,
  env_var_count: section.metadata.envVarCount,
  env_vars:
    section.metadata.envVars === null
      ? null
      : section.metadata.envVars.map((item) => ({
          name: item.name,
          value: item.value,
          value_byte_length: item.valueByteLength,
        })),
  ca_data:
    section.metadata.caData === null ? null : [...section.metadata.caData],
  ca_data_byte_length: section.metadata.caDataByteLength,
  specifier_count: section.specifiers.count,
  specifier_byte_length: section.specifiers.byteLength,
  specifier_listing: section.specifiers.listing,
  redirect_count: section.redirects.count,
  redirect_byte_length: section.redirects.byteLength,
  redirect_listing: section.redirects.listing,
  remote_module_count: section.remoteModules.count,
  remote_module_byte_length: section.remoteModules.byteLength,
  remote_module_listing: section.remoteModules.listing,
  vfs_header_byte_length: section.vfsHeaderByteLength,
  vfs_file_data_byte_length: section.vfsFileData.length,
  vfs_listing: section.vfs.listing,
  vfs_case_sensitivity: section.metadata.vfsCaseSensitivity,
});

const vfsEntry = (
  sectionOffset: number,
  section: DenoParsedSection,
  member: DenoVfsMember,
): ArtifactEntry => {
  const metadata: DenoStandaloneEntryMetadata = {
    kind: "deno-standalone-entry",
    role: member.role,
    index: member.index,
    source_path: member.sourcePath,
    entry_point: isEntryPoint(
      member.role,
      member.sourcePath,
      section.metadata.entrypointKey,
    ),
    executable: member.executable,
    is_valid_utf8: member.isValidUtf8,
    symlink_dest_parts:
      member.symlinkDestParts === null ? null : [...member.symlinkDestParts],
    media_type: null,
    media_type_name: null,
  };
  const physical =
    member.offset === null || member.length === null
      ? null
      : {
          offset:
            sectionOffset + section.vfsFileData.sectionOffset + member.offset,
          length: member.length,
        };
  return storedEntry(
    member.path,
    member.sourcePath,
    member.limitations,
    physical,
    metadata,
  );
};

const remoteEntries = (
  sectionOffset: number,
  section: DenoParsedSection,
  module: DenoRemoteModule,
  destination: RemoteDestination,
): ArtifactEntry[] => {
  const regions: readonly {
    readonly role: DenoStandaloneEntryMetadata["role"];
    readonly range: DenoByteRange;
  }[] = [
    { role: "remote-module", range: module.data },
    ...(module.transpiled === null
      ? []
      : [{ role: "remote-transpiled" as const, range: module.transpiled }]),
    ...(module.sourceMap === null
      ? []
      : [{ role: "remote-source-map" as const, range: module.sourceMap }]),
    ...(module.cjsExportAnalysis === null
      ? []
      : [
          {
            role: "remote-cjs-export-analysis" as const,
            range: module.cjsExportAnalysis,
          },
        ]),
  ];
  return regions.map(({ role, range }) => {
    const suffix =
      role === "remote-module"
        ? ""
        : role === "remote-transpiled"
          ? DENO_CHILD_SUFFIXES.transpiled
          : role === "remote-source-map"
            ? DENO_CHILD_SUFFIXES.sourceMap
            : DENO_CHILD_SUFFIXES.cjsExportAnalysis;
    const path = `${destination.path}${suffix}`;
    const metadata: DenoStandaloneEntryMetadata = {
      kind: "deno-standalone-entry",
      role,
      index: module.index,
      source_path: destination.sourcePath,
      entry_point: isEntryPoint(
        role,
        destination.sourcePath,
        section.metadata.entrypointKey,
      ),
      executable: false,
      is_valid_utf8: module.isValidUtf8,
      symlink_dest_parts: null,
      media_type: module.mediaType,
      media_type_name: denoMediaTypeName(module.mediaType),
    };
    return storedEntry(
      path,
      destination.sourcePath,
      destination.limitations,
      { offset: sectionOffset + range.sectionOffset, length: range.length },
      metadata,
    );
  });
};

const storedEntry = (
  path: string,
  sourcePath: string | null,
  limitations: readonly string[],
  physical: { readonly offset: number; readonly length: number } | null,
  metadata: DenoStandaloneEntryMetadata,
): ArtifactEntry => ({
  path,
  ...(sourcePath === null ? {} : { sourcePath }),
  kind: metadata.role === "vfs-symlink" ? "symlink" : "file",
  declaredSize: physical?.length ?? null,
  compressedSize: null,
  executable: metadata.executable,
  encrypted: false,
  byteOffset: physical?.offset ?? null,
  declaredIntegrity: null,
  unpacked: false,
  limitations: [...limitations],
  adapterKey: `deno:${String(metadata.index)}:${metadata.role}`,
  formatMetadata: metadata,
});

const isEntryPoint = (
  role: DenoStandaloneEntryMetadata["role"],
  sourcePath: string | null,
  entrypointKey: string,
): boolean =>
  (role === "vfs-file" || role === "remote-module" || role === "vfs-symlink") &&
  sourcePath === entrypointKey;

const remoteUrlSuffix = (url: URL): string => {
  const identity = `${url.search}${url.hash}`;
  return identity.length === 0 ? "" : encodeURIComponent(identity);
};

const remoteDestination = (
  section: DenoParsedSection,
  module: DenoRemoteModule,
): RemoteDestination => {
  const fallback = `deno-remote/${String(module.index)}`;
  // A listed remote table has every specifier. Missing text is unsupported.
  const text = section.specifierText?.get(module.specifierId) ?? null;
  if (text === null)
    return {
      path: fallback,
      sourcePath: null,
      limitations: [
        "The remote specifier is not available as a logical path; an indexed path is used.",
      ],
    };
  let candidate = text;
  try {
    const url = new URL(text);
    const suffix = remoteUrlSuffix(url);
    if (url.protocol === "file:") {
      let pathname = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:/u.test(pathname)) pathname = pathname.slice(1);
      candidate = `${pathname.replace(/^\/+/u, "")}${suffix}`;
    } else if (url.protocol === "http:" || url.protocol === "https:") {
      const path = url.pathname.replace(/^\/+/u, "");
      candidate = `deno-remote/${url.host}${path.length === 0 ? "" : `/${path}`}${suffix}`;
    }
  } catch {
    candidate = text.replace(/^\/+/u, "");
  }
  let parts = 1;
  for (let index = 0; index < candidate.length; index += 1)
    if (
      candidate.charCodeAt(index) === 47 &&
      ++parts > MAX_DENO_LOGICAL_PATH_PARTS
    )
      return {
        path: fallback,
        sourcePath: text,
        limitations: [
          `The virtual name exceeds the fixed ${String(MAX_DENO_LOGICAL_PATH_PARTS)}-part logical path allowance; an indexed path is used and the original name is retained.`,
        ],
      };
  let normalized: string;
  try {
    normalized = normalizeArtifactPath(candidate);
  } catch (cause) {
    if (!(cause instanceof ArtifactReaderFailure) || cause.reason !== "path")
      throw cause;
    return {
      path: fallback,
      sourcePath: text,
      limitations: [
        "The virtual name is not a safe relative path; an indexed path is used and the original name is retained.",
      ],
    };
  }
  // A specifier is generated into a path, so its spelling can follow every
  // destination. The original stays in `sourcePath`.
  const portable = normalized.replace(
    NON_PORTABLE_PATH_CHARACTERS,
    encodeURIComponent,
  );
  if (
    !remoteConcretePaths(portable, module).every((path) =>
      denoLogicalPathFits(path),
    )
  )
    return {
      path: fallback,
      sourcePath: text,
      limitations: [DENO_PATH_LENGTH_LIMITATION],
    };
  return {
    path: portable,
    sourcePath: text,
    limitations: [],
  };
};

const SHARED_REMOTE_PATH_LIMITATION =
  "The remote specifier shares a logical path prefix with another embedded path; an indexed path is used and the original specifier is retained.";

const remoteConcretePaths = (
  path: string,
  module: DenoRemoteModule,
): readonly string[] => [
  path,
  ...(module.transpiled === null
    ? []
    : [`${path}${DENO_CHILD_SUFFIXES.transpiled}`]),
  ...(module.sourceMap === null
    ? []
    : [`${path}${DENO_CHILD_SUFFIXES.sourceMap}`]),
  ...(module.cjsExportAnalysis === null
    ? []
    : [`${path}${DENO_CHILD_SUFFIXES.cjsExportAnalysis}`]),
];

/**
 * Query strings stay in the logical path. A remote path that is equal to, or
 * a file/directory prefix of, another embedded path is indexed so extraction
 * can materialize every selected member. Occupancy is the path registry.
 */
const assignRemoteDestinations = (
  section: DenoParsedSection,
  paths: ArtifactPathRegistry,
): ReadonlyMap<number, RemoteDestination> => {
  const modules = section.remoteModules.modules;
  const assigned = new Map<number, RemoteDestination>();
  let salt = 0;
  const fits = (module: DenoRemoteModule, path: string): boolean =>
    remoteConcretePaths(path, module).every(
      (concrete) => !paths.conflicts(concrete),
    );
  const take = (module: DenoRemoteModule, path: string): void => {
    for (const concrete of remoteConcretePaths(path, module))
      paths.reservePath(concrete);
  };
  for (const module of modules) {
    const natural = remoteDestination(section, module);
    if (fits(module, natural.path)) {
      assigned.set(module.index, natural);
      take(module, natural.path);
      continue;
    }
    const fallback = (): string =>
      `${salt === 0 ? "deno-remote" : `deno-remote-${String(salt)}`}/${String(module.index)}`;
    let selected = fallback();
    // Distinct top-level namespaces cannot share a blocking ancestor. Each
    // rejection accounts for at least one occupied VFS or remote path, so the
    // finite registry bounds this search without an artificial retry ceiling.
    // Keep the salt across modules so rejected namespaces are visited once.
    while (!fits(module, selected)) {
      salt += 1;
      selected = fallback();
    }
    assigned.set(module.index, {
      path: selected,
      sourcePath: natural.sourcePath,
      limitations: natural.limitations.includes(SHARED_REMOTE_PATH_LIMITATION)
        ? natural.limitations
        : [...natural.limitations, SHARED_REMOTE_PATH_LIMITATION],
    });
    take(module, selected);
  }
  return assigned;
};

const memberStream = (entry: ArtifactEntry): Transform => {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(null, chunk);
    },
    flush(callback) {
      callback(
        bytes === entry.declaredSize
          ? null
          : denoFormatFailure(`member ended early: ${entry.path}`),
      );
    },
  });
};

const denoRetainedLimit = (claimed: number): ArtifactReaderFailure => {
  const allowance = `Deno compile retained metadata allowance of ${String(MAX_DENO_RETAINED_BYTES)} bytes`;
  const message = `The retained metadata claims ${String(claimed)} bytes. ${fixedAllowanceRemediation(allowance, "parser")} This release has no runtime override.`;
  return new ArtifactReaderFailure("limit", message, {
    boundary: "memory",
    userMessage: message,
  });
};
