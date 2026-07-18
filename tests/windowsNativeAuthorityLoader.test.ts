import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createWindowsNativeAuthorityPackageLoader,
  WindowsNativeAuthorityPackageLoader,
  type WindowsNativeAuthorityLoadHost,
  type WindowsNativeAuthorityPackageCommitment,
} from "../src/application/WindowsNativeAuthorityLoader.js";
import {
  unavailableWindowsNativeAuthorityBackend,
  type WindowsNativeAuthorityBackend,
} from "../src/application/WindowsNativeAuthority.js";

const artifact = Buffer.from("source-owned-windows-native-addon");
const digest = createHash("sha256").update(artifact).digest("hex");
const packageManifestObject = {
  name: "@rea/windows-x64",
  version: "2.0.0",
  os: ["win32"],
  cpu: ["x64"],
  reaNativeAuthority: {
    contractVersion: 1,
    nodeApiVersion: 9,
    artifact: "rea.node",
    artifactSha256: digest,
    exports: [
      "admitDirectory",
      "admitFile",
      "createPrivateRoot",
      "identity",
      "spawnOwnedProcess",
    ],
  },
} as const;
const packageManifest = Buffer.from(JSON.stringify(packageManifestObject));

const commitment: WindowsNativeAuthorityPackageCommitment = {
  packageName: "@rea/windows-x64",
  packageVersion: "2.0.0",
  contractVersion: 1,
  nodeApiVersion: 9,
  artifactSha256: digest,
};

const backend = (): WindowsNativeAuthorityBackend => ({
  ...unavailableWindowsNativeAuthorityBackend("not exercised"),
  identity: {
    packageName: commitment.packageName,
    packageVersion: commitment.packageVersion,
    contractVersion: commitment.contractVersion,
    nodeApiVersion: commitment.nodeApiVersion,
    artifactSha256: digest,
  },
});

class RecordingLoadHost implements WindowsNativeAuthorityLoadHost {
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly nodeApiVersion: number | null;
  readonly events: string[] = [];
  module: unknown = backend();
  bytes: Uint8Array = artifact;
  manifestBytes: Uint8Array = packageManifest;
  cachedValue: unknown | undefined;
  resolveFailure: unknown | undefined;

  constructor(
    options: {
      readonly platform?: NodeJS.Platform;
      readonly architecture?: string;
      readonly nodeApiVersion?: number | null;
    } = {},
  ) {
    this.platform = options.platform ?? "win32";
    this.architecture = options.architecture ?? "x64";
    this.nodeApiVersion =
      options.nodeApiVersion === undefined ? 10 : options.nodeApiVersion;
  }

  resolve(packageName: string): string {
    this.events.push(`resolve:${packageName}`);
    if (this.resolveFailure !== undefined) throw this.resolveFailure;
    return "C:\\rea\\node_modules\\@rea\\windows-x64\\rea.node";
  }

  resolveManifest(packageName: string): string {
    this.events.push(`resolve-manifest:${packageName}`);
    return "C:\\rea\\node_modules\\@rea\\windows-x64\\package.json";
  }

  async canonicalize(path: string): Promise<string> {
    this.events.push("canonicalize");
    return path.toLowerCase();
  }

  async read(path: string): Promise<Uint8Array> {
    if (path.endsWith("package.json")) {
      this.events.push("read-manifest");
      return this.manifestBytes;
    }
    this.events.push("read-addon");
    return this.bytes;
  }

  cached(_path: string): unknown | undefined {
    this.events.push("cached");
    return this.cachedValue;
  }

  load(_path: string): unknown {
    this.events.push("load");
    return this.module;
  }
}

describe("Windows native authority package loader", () => {
  it("owns one production loader for the process lifetime", () => {
    expect(createWindowsNativeAuthorityPackageLoader()).toBe(
      createWindowsNativeAuthorityPackageLoader(),
    );
  });

  it("loads and pins one exact release tuple idempotently", async () => {
    const host = new RecordingLoadHost();
    const loader = new WindowsNativeAuthorityPackageLoader(host, commitment);

    const [first, concurrent] = await Promise.all([
      loader.load(),
      loader.load(),
    ]);
    const second = await loader.load();

    expect(first).toMatchObject({ ok: true });
    expect(concurrent).toEqual(first);
    expect(second).toEqual(first);
    expect(host.events).toEqual([
      "resolve-manifest:@rea/windows-x64",
      "canonicalize",
      "read-manifest",
      "resolve:@rea/windows-x64",
      "canonicalize",
      "canonicalize",
      "cached",
      "read-addon",
      "load",
    ]);
  });

  it.each([
    ["wrong platform", { platform: "linux" as const }, commitment],
    ["wrong architecture", { architecture: "arm64" }, commitment],
    ["old Node-API", { nodeApiVersion: 8 }, commitment],
    ["missing Node-API", { nodeApiVersion: null }, commitment],
    ["uncommitted artifact", {}, { ...commitment, artifactSha256: null }],
  ])(
    "fails before package resolution for %s",
    async (_name, options, expected) => {
      const host = new RecordingLoadHost(options);
      const result = await new WindowsNativeAuthorityPackageLoader(
        host,
        expected,
      ).load();

      expect(result).toMatchObject({
        ok: false,
        error: { reason: "unavailable" },
      });
      expect(host.events).toEqual([]);
    },
  );

  it("fails closed when the optional package is absent", async () => {
    const host = new RecordingLoadHost();
    host.resolveFailure = new Error("module details must not escape");

    const result = await new WindowsNativeAuthorityPackageLoader(
      host,
      commitment,
    ).load();

    expect(result).toMatchObject({
      ok: false,
      error: {
        reason: "unavailable",
        message:
          "Windows native authority package is not installed or resolvable",
      },
    });
    expect(host.events).toEqual([
      "resolve-manifest:@rea/windows-x64",
      "canonicalize",
      "read-manifest",
      "resolve:@rea/windows-x64",
    ]);
  });

  it("rejects platform manifest drift before addon resolution", async () => {
    const host = new RecordingLoadHost();
    host.manifestBytes = Buffer.from(
      JSON.stringify({
        ...packageManifestObject,
        version: "1.0.0",
      }),
    );

    const result = await new WindowsNativeAuthorityPackageLoader(
      host,
      commitment,
    ).load();

    expect(result).toMatchObject({
      ok: false,
      error: { reason: "native_contract_mismatch" },
    });
    expect(host.events).not.toContain("resolve:@rea/windows-x64");
    expect(host.events).not.toContain("load");
  });

  it("rejects cache contamination and digest drift before evaluation", async () => {
    const cached = new RecordingLoadHost();
    cached.cachedValue = backend();
    const cachedResult = await new WindowsNativeAuthorityPackageLoader(
      cached,
      commitment,
    ).load();
    expect(cachedResult).toMatchObject({
      ok: false,
      error: { reason: "native_contract_mismatch" },
    });
    expect(cached.events).not.toContain("read-addon");
    expect(cached.events).not.toContain("load");

    const drifted = new RecordingLoadHost();
    drifted.bytes = Buffer.from("different-addon");
    const driftedResult = await new WindowsNativeAuthorityPackageLoader(
      drifted,
      commitment,
    ).load();
    expect(driftedResult).toMatchObject({
      ok: false,
      error: { reason: "identity_drift" },
    });
    expect(drifted.events).not.toContain("load");
  });

  it.each([
    ["non-object", null],
    ["extra export", { ...backend(), unexpected: true }],
    ["missing operation", { ...backend(), admitFile: undefined }],
    [
      "wrong package version",
      {
        ...backend(),
        identity: { ...backend().identity, packageVersion: "1.0.0" },
      },
    ],
  ])("rejects a %s native contract", async (_name, module) => {
    const host = new RecordingLoadHost();
    host.module = module;

    const result = await new WindowsNativeAuthorityPackageLoader(
      host,
      commitment,
    ).load();

    expect(result).toMatchObject({
      ok: false,
      error: { reason: "native_contract_mismatch" },
    });
  });
});
