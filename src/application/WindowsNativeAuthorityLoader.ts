import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { win32 } from "node:path";

import { z } from "zod";

import { PACKAGE_METADATA } from "../generatedPackageMetadata.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  WindowsNativeAuthorityError,
  type WindowsNativeAuthorityBackend,
  type WindowsNativeAuthorityIdentity,
} from "./WindowsNativeAuthority.js";

const BACKEND_EXPORTS = [
  "admitDirectory",
  "admitFile",
  "createPrivateRoot",
  "identity",
  "spawnOwnedProcess",
] as const;

const identitySchema = z.strictObject({
  packageName: z.string().min(1),
  packageVersion: z.string().min(1),
  contractVersion: z.number().int().positive(),
  nodeApiVersion: z.number().int().positive(),
  artifactSha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

const packageManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  os: z.tuple([z.literal("win32")]),
  cpu: z.tuple([z.literal("x64")]),
  scripts: z.undefined().optional(),
  reaNativeAuthority: z.strictObject({
    contractVersion: z.number().int().positive(),
    nodeApiVersion: z.number().int().positive(),
    artifact: z.string().regex(/^[^\\/]+\.node$/u),
    artifactSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    exports: z.tuple([
      z.literal("admitDirectory"),
      z.literal("admitFile"),
      z.literal("createPrivateRoot"),
      z.literal("identity"),
      z.literal("spawnOwnedProcess"),
    ]),
  }),
});

/** Release-generated identity required before the Windows addon can load. */
export interface WindowsNativeAuthorityPackageCommitment {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly contractVersion: number;
  readonly nodeApiVersion: number;
  readonly artifactSha256: string | null;
}

/** Injectable Node package-loading seam used by the production loader. */
export interface WindowsNativeAuthorityLoadHost {
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly nodeApiVersion: number | null;
  resolve(packageName: string): string;
  resolveManifest(packageName: string): string;
  canonicalize(path: string): Promise<string>;
  read(path: string): Promise<Uint8Array>;
  cached(path: string): unknown | undefined;
  load(path: string): unknown;
}

interface LoadedBackend {
  readonly backend: LoadedWindowsNativeBackend;
  readonly canonicalPath: string;
  readonly identity: WindowsNativeAuthorityIdentity;
}

type LoadedWindowsNativeBackend = WindowsNativeAuthorityBackend & {
  readonly identity: WindowsNativeAuthorityIdentity;
};

const require = createRequire(import.meta.url);

/** Production host backed by Node's exact CommonJS/native-addon loader. */
export const systemWindowsNativeAuthorityLoadHost =
  (): WindowsNativeAuthorityLoadHost => ({
    platform: process.platform,
    architecture: process.arch,
    nodeApiVersion: parseNodeApiVersion(process.versions.napi),
    resolve: (packageName) => require.resolve(packageName),
    resolveManifest: (packageName) =>
      require.resolve(`${packageName}/package.json`),
    canonicalize: realpath,
    read: readFile,
    cached: (path) => require.cache[path]?.exports,
    load: (path) => require(path),
  });

/** Stateful process-lifetime loader for one pinned native module identity. */
export class WindowsNativeAuthorityPackageLoader {
  private loaded: LoadedBackend | undefined;
  private loading:
    | Promise<
        Result<WindowsNativeAuthorityBackend, WindowsNativeAuthorityError>
      >
    | undefined;

  constructor(
    private readonly host: WindowsNativeAuthorityLoadHost,
    private readonly commitment: WindowsNativeAuthorityPackageCommitment,
  ) {}

  /** Load once and pin either the backend or its failure for this process. */
  load(): Promise<
    Result<WindowsNativeAuthorityBackend, WindowsNativeAuthorityError>
  > {
    if (this.loaded !== undefined)
      return Promise.resolve(ok(this.loaded.backend));
    this.loading ??= this.loadOnce();
    return this.loading;
  }

  private async loadOnce(): Promise<
    Result<WindowsNativeAuthorityBackend, WindowsNativeAuthorityError>
  > {
    const supported = this.checkRuntime();
    if (!supported.ok) return supported;
    const manifest = await this.readManifest();
    if (!manifest.ok) return manifest;
    let resolvedPath: string;
    try {
      resolvedPath = await this.host.canonicalize(
        this.host.resolve(this.commitment.packageName),
      );
    } catch (cause: unknown) {
      return err(
        loadError(
          "unavailable",
          "Windows native authority package is not installed or resolvable",
          cause,
        ),
      );
    }
    let expectedArtifactPath: string;
    try {
      expectedArtifactPath = await this.host.canonicalize(
        win32.resolve(
          win32.dirname(manifest.value.path),
          manifest.value.artifact,
        ),
      );
    } catch (cause: unknown) {
      return err(
        loadError(
          "unavailable",
          "Windows native authority declared addon is unavailable",
          cause,
        ),
      );
    }
    if (resolvedPath !== expectedArtifactPath)
      return err(
        loadError(
          "native_contract_mismatch",
          "Windows native authority package resolved an unexpected addon path",
        ),
      );
    if (this.host.cached(resolvedPath) !== undefined)
      return err(
        loadError(
          "native_contract_mismatch",
          "Windows native authority addon was cached before identity verification",
        ),
      );
    let artifact: Uint8Array;
    try {
      artifact = await this.host.read(resolvedPath);
    } catch (cause: unknown) {
      return err(
        loadError(
          "unavailable",
          "Windows native authority addon could not be read",
          cause,
        ),
      );
    }
    const digest = createHash("sha256").update(artifact).digest("hex");
    if (digest !== this.commitment.artifactSha256)
      return err(
        loadError(
          "identity_drift",
          "Windows native authority addon digest does not match this REA release",
        ),
      );
    let module: unknown;
    try {
      module = this.host.load(resolvedPath);
    } catch (cause: unknown) {
      return err(
        loadError(
          "unavailable",
          "Windows native authority addon could not be loaded",
          cause,
        ),
      );
    }
    const parsed = parseBackend(module, this.commitment, digest);
    if (!parsed.ok) return parsed;
    this.loaded = {
      backend: parsed.value,
      canonicalPath: resolvedPath,
      identity: parsed.value.identity,
    };
    return ok(parsed.value);
  }

  private checkRuntime(): Result<void, WindowsNativeAuthorityError> {
    if (this.host.platform !== "win32" || this.host.architecture !== "x64")
      return err(
        loadError(
          "unavailable",
          "Windows native authority requires Windows x64",
        ),
      );
    if (this.commitment.artifactSha256 === null)
      return err(
        loadError(
          "unavailable",
          "This REA build has no committed Windows native authority artifact",
        ),
      );
    if (
      this.host.nodeApiVersion === null ||
      this.host.nodeApiVersion < this.commitment.nodeApiVersion
    )
      return err(
        loadError(
          "unavailable",
          "Windows native authority requires the committed Node-API version",
        ),
      );
    return ok(undefined);
  }

  private async readManifest(): Promise<
    Result<
      { readonly path: string; readonly artifact: string },
      WindowsNativeAuthorityError
    >
  > {
    let path: string;
    let bytes: Uint8Array;
    try {
      path = await this.host.canonicalize(
        this.host.resolveManifest(this.commitment.packageName),
      );
      bytes = await this.host.read(path);
    } catch (cause: unknown) {
      return err(
        loadError(
          "unavailable",
          "Windows native authority package manifest is unavailable",
          cause,
        ),
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch (cause: unknown) {
      return err(
        loadError(
          "native_contract_mismatch",
          "Windows native authority package manifest is not valid JSON",
          cause,
        ),
      );
    }
    const parsed = packageManifestSchema.safeParse(decoded);
    if (
      !parsed.success ||
      parsed.data.name !== this.commitment.packageName ||
      parsed.data.version !== this.commitment.packageVersion ||
      parsed.data.reaNativeAuthority.contractVersion !==
        this.commitment.contractVersion ||
      parsed.data.reaNativeAuthority.nodeApiVersion !==
        this.commitment.nodeApiVersion ||
      parsed.data.reaNativeAuthority.artifactSha256 !==
        this.commitment.artifactSha256
    )
      return err(
        loadError(
          "native_contract_mismatch",
          "Windows native authority package manifest does not match this REA release",
        ),
      );
    return ok({
      path,
      artifact: parsed.data.reaNativeAuthority.artifact,
    });
  }
}

let productionLoader: WindowsNativeAuthorityPackageLoader | undefined;

/** Return the one process-global loader for release-generated package metadata. */
export const createWindowsNativeAuthorityPackageLoader =
  (): WindowsNativeAuthorityPackageLoader => {
    productionLoader ??= new WindowsNativeAuthorityPackageLoader(
      systemWindowsNativeAuthorityLoadHost(),
      PACKAGE_METADATA.windowsNativeAuthority,
    );
    return productionLoader;
  };

const parseBackend = (
  input: unknown,
  commitment: WindowsNativeAuthorityPackageCommitment,
  digest: string,
): Result<LoadedWindowsNativeBackend, WindowsNativeAuthorityError> => {
  if (typeof input !== "object" || input === null)
    return err(
      loadError(
        "native_contract_mismatch",
        "Windows native authority addon exported a non-object contract",
      ),
    );
  const keys = Object.keys(input).sort((left, right) =>
    left.localeCompare(right),
  );
  if (!sameStrings(keys, BACKEND_EXPORTS))
    return err(
      loadError(
        "native_contract_mismatch",
        "Windows native authority addon export set does not match the contract",
      ),
    );
  const candidate = input as Record<string, unknown>;
  const identity = identitySchema.safeParse(candidate.identity);
  if (!identity.success || !sameIdentity(identity.data, commitment, digest))
    return err(
      loadError(
        "native_contract_mismatch",
        "Windows native authority addon identity does not match this REA release",
      ),
    );
  if (
    typeof candidate.admitFile !== "function" ||
    typeof candidate.admitDirectory !== "function" ||
    typeof candidate.createPrivateRoot !== "function" ||
    typeof candidate.spawnOwnedProcess !== "function"
  )
    return err(
      loadError(
        "native_contract_mismatch",
        "Windows native authority addon operations do not match the contract",
      ),
    );
  // SAFETY: the exact export set, identity, and every callable backend operation
  // were checked above. Operation results remain parsed by WindowsNativeAuthority.
  return ok(candidate as unknown as LoadedWindowsNativeBackend);
};

const sameIdentity = (
  identity: WindowsNativeAuthorityIdentity,
  commitment: WindowsNativeAuthorityPackageCommitment,
  digest: string,
): boolean =>
  identity.packageName === commitment.packageName &&
  identity.packageVersion === commitment.packageVersion &&
  identity.contractVersion === commitment.contractVersion &&
  identity.nodeApiVersion === commitment.nodeApiVersion &&
  identity.artifactSha256 === digest;

const sameStrings = (
  actual: readonly string[],
  expected: readonly string[],
): boolean =>
  actual.length === expected.length &&
  actual.every((value, index) => value === expected[index]);

const parseNodeApiVersion = (value: string | undefined): number | null => {
  if (value === undefined || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const loadError = (
  reason: "unavailable" | "identity_drift" | "native_contract_mismatch",
  message: string,
  cause?: unknown,
): WindowsNativeAuthorityError =>
  new WindowsNativeAuthorityError(
    "load_native_authority",
    reason,
    message,
    cause === undefined ? undefined : { cause },
  );
