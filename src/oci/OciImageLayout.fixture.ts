import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
const OCI_LAYER = "application/vnd.oci.image.layer.v1.tar+gzip";

/** SHA-256 digest of bytes as an OCI descriptor digest. */
export const ociSha256Digest = (bytes: Uint8Array | string): string => {
  const body = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
};

/** Write `bytes` under `blobs/<alg>/<hex>` and return the descriptor digest. */
export const putOciBlob = async (
  root: string,
  bytes: Uint8Array | string,
  algorithm: "sha256" | "sha512" = "sha256",
): Promise<string> => {
  const body = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  const hex = createHash(algorithm).update(body).digest("hex");
  const directory = join(root, "blobs", algorithm);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, hex), body);
  return `${algorithm}:${hex}`;
};

const writeJson = (value: unknown): string => `${JSON.stringify(value)}\n`;

export interface OciImageLayoutFixtureConfig {
  readonly architecture?: string;
  readonly os?: string;
  readonly variant?: string;
  readonly created?: string;
  readonly author?: string;
  readonly user?: string;
  readonly env?: readonly string[];
  readonly entrypoint?: readonly string[];
  readonly cmd?: readonly string[];
  readonly workingDir?: string;
  readonly exposedPorts?: Readonly<Record<string, unknown>>;
  readonly volumes?: Readonly<Record<string, unknown>>;
  readonly labels?: Readonly<Record<string, string>>;
  readonly stopSignal?: string;
  readonly diffIds?: readonly string[];
  readonly history?: readonly {
    readonly created?: string;
    readonly created_by?: string;
    readonly empty_layer?: boolean;
    readonly comment?: string;
  }[];
}

export interface OciImageLayoutFixtureOptions {
  readonly layoutVersion?: string;
  readonly config?: OciImageLayoutFixtureConfig;
  readonly layerBytes?: Uint8Array;
  readonly refName?: string;
  readonly extraIndexAnnotations?: Readonly<Record<string, string>>;
}

const defaultConfig = (
  options: OciImageLayoutFixtureConfig,
  layerDigest: string,
): Record<string, unknown> => ({
  architecture: options.architecture ?? "amd64",
  os: options.os ?? "linux",
  ...(options.variant === undefined ? {} : { variant: options.variant }),
  created: options.created ?? "2024-01-02T03:04:05Z",
  author: options.author ?? "fixture@example.invalid",
  config: {
    User: options.user ?? "nobody",
    Env: options.env ?? ["PATH=/usr/bin", "SECRET=redact-me"],
    Entrypoint: options.entrypoint ?? ["/bin/sh"],
    Cmd: options.cmd ?? ["-c", "true"],
    WorkingDir: options.workingDir ?? "/",
    ExposedPorts: options.exposedPorts ?? { "80/tcp": {} },
    Volumes: options.volumes ?? { "/data": {} },
    Labels: options.labels ?? { "org.opencontainers.image.title": "fixture" },
    StopSignal: options.stopSignal ?? "SIGTERM",
  },
  rootfs: {
    type: "layers",
    diff_ids: options.diffIds ?? [layerDigest],
  },
  history: options.history ?? [
    {
      created: "2024-01-02T03:04:05Z",
      created_by: "/bin/sh -c #(nop) ADD layer",
      empty_layer: false,
    },
    {
      created: "2024-01-02T03:04:06Z",
      created_by: "/bin/sh -c #(nop) ENV SECRET=redact-me",
      empty_layer: true,
    },
  ],
});

/** Write a valid single-platform OCI image layout under `root`. */
export const writeOciImageLayoutFixture = async (
  root: string,
  options: OciImageLayoutFixtureOptions = {},
): Promise<{
  readonly manifestDigest: string;
  readonly configDigest: string;
  readonly layerDigest: string;
  readonly indexDigest: string;
  readonly manifestSize: number;
}> => {
  await mkdir(root, { recursive: true });
  const layerBytes = options.layerBytes ?? Buffer.from("layer-bytes");
  const layerDigest = await putOciBlob(root, layerBytes);
  const configJson = writeJson(
    defaultConfig(options.config ?? {}, layerDigest),
  );
  const configDigest = await putOciBlob(root, configJson);
  const manifestJson = writeJson({
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    config: {
      mediaType: OCI_CONFIG,
      digest: configDigest,
      size: Buffer.byteLength(configJson),
    },
    layers: [
      {
        mediaType: OCI_LAYER,
        digest: layerDigest,
        size: layerBytes.length,
      },
    ],
  });
  const manifestDigest = await putOciBlob(root, manifestJson);
  const indexJson = writeJson({
    schemaVersion: 2,
    mediaType: OCI_INDEX,
    manifests: [
      {
        mediaType: OCI_MANIFEST,
        digest: manifestDigest,
        size: Buffer.byteLength(manifestJson),
        platform: {
          architecture: options.config?.architecture ?? "amd64",
          os: options.config?.os ?? "linux",
          ...(options.config?.variant === undefined
            ? {}
            : { variant: options.config.variant }),
        },
        annotations: {
          "org.opencontainers.image.ref.name": options.refName ?? "latest",
          ...options.extraIndexAnnotations,
        },
      },
    ],
  });
  await writeFile(join(root, "index.json"), indexJson);
  await writeFile(
    join(root, "oci-layout"),
    writeJson({
      imageLayoutVersion: options.layoutVersion ?? "1.0.0",
    }),
  );
  return {
    manifestDigest,
    configDigest,
    layerDigest,
    indexDigest: ociSha256Digest(indexJson),
    manifestSize: Buffer.byteLength(manifestJson),
  };
};

/** Write a multi-platform index that points at two image manifests. */
export const writeMultiPlatformOciImageLayoutFixture = async (
  root: string,
): Promise<{
  readonly amd64: string;
  readonly arm64: string;
}> => {
  await mkdir(root, { recursive: true });
  const layerDigest = await putOciBlob(root, Buffer.from("shared-layer"));
  const writeImage = async (architecture: string, refName: string) => {
    const configJson = writeJson(
      defaultConfig({ architecture, os: "linux" }, layerDigest),
    );
    const configDigest = await putOciBlob(root, configJson);
    const manifestJson = writeJson({
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: {
        mediaType: OCI_CONFIG,
        digest: configDigest,
        size: Buffer.byteLength(configJson),
      },
      layers: [
        {
          mediaType: OCI_LAYER,
          digest: layerDigest,
          size: 12,
        },
      ],
    });
    const digest = await putOciBlob(root, manifestJson);
    return {
      mediaType: OCI_MANIFEST,
      digest,
      size: Buffer.byteLength(manifestJson),
      platform: { architecture, os: "linux" },
      annotations: { "org.opencontainers.image.ref.name": refName },
    };
  };
  const amd64 = await writeImage("amd64", "linux/amd64");
  const arm64 = await writeImage("arm64", "linux/arm64");
  const indexJson = writeJson({
    schemaVersion: 2,
    mediaType: OCI_INDEX,
    manifests: [amd64, arm64],
  });
  await writeFile(join(root, "index.json"), indexJson);
  await writeFile(
    join(root, "oci-layout"),
    writeJson({ imageLayoutVersion: "1.0.0" }),
  );
  return { amd64: amd64.digest, arm64: arm64.digest };
};

/** Write nested indexes of `depth` wrapping one image manifest. */
export const writeNestedOciIndexFixture = async (
  root: string,
  depth: number,
): Promise<void> => {
  const inner = await writeOciImageLayoutFixture(root);
  let current = {
    mediaType: OCI_MANIFEST,
    digest: inner.manifestDigest,
    size: inner.manifestSize,
  };
  for (let level = 0; level < depth; level += 1) {
    const nested = writeJson({
      schemaVersion: 2,
      mediaType: OCI_INDEX,
      manifests: [current],
    });
    const digest = await putOciBlob(root, nested);
    current = {
      mediaType: OCI_INDEX,
      digest,
      size: Buffer.byteLength(nested),
    };
  }
  await writeFile(
    join(root, "index.json"),
    writeJson({
      schemaVersion: 2,
      mediaType: OCI_INDEX,
      manifests: [current],
    }),
  );
};
