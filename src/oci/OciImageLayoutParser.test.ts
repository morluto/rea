import {
  mkdir,
  readFile,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import {
  inspectOciImageLayoutInputSchema,
  ociImageLayoutSchema,
  parseOciDigest,
} from "../domain/oci/imageLayout.js";
import { ParseFailureError } from "../domain/parseFailure.js";
import { primaryAnalysisError } from "../domain/analysisErrorBase.js";
import { parseEvidence } from "../domain/evidence.js";
import {
  ArtifactReaderFailure,
  DirectoryArtifactReader,
} from "../resources/index.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  putOciBlob,
  writeMultiPlatformOciImageLayoutFixture,
  writeNestedOciIndexFixture,
  writeOciImageLayoutFixture,
} from "./OciImageLayout.fixture.js";
import {
  OCI_IMAGE_LAYOUT_LIMITATIONS,
  OciImageLayoutRefusal,
  parseOciImageLayout,
} from "./OciImageLayoutParser.js";
import { OciImageLayoutProvider } from "./OciImageLayoutProvider.js";

const inspectLayout = async (
  root: string,
  extra: Record<string, unknown> = {},
) => {
  const reader = new DirectoryArtifactReader(root);
  try {
    return ociImageLayoutSchema.parse(
      await parseOciImageLayout(
        reader,
        inspectOciImageLayoutInputSchema.parse({ path: root, ...extra }),
      ),
    );
  } finally {
    await reader.close();
  }
};

it("inventories a single-platform layout and keeps Env values by default", async () => {
  const root = await createTestTempDirectory("rea-oci-valid-");
  const written = await writeOciImageLayoutFixture(root);
  const report = await inspectLayout(root);
  expect(report.artifact.layout_version).toBe("1.0.0");
  expect(report.artifact.format).toBe("directory");
  expect(report.indexes).toHaveLength(1);
  expect(report.indexes[0]?.depth).toBe(0);
  expect(report.indexes[0]?.entries).toEqual([
    expect.objectContaining({
      media_type: "application/vnd.oci.image.manifest.v1+json",
      digest: written.manifestDigest,
      platform: expect.objectContaining({
        architecture: "amd64",
        os: "linux",
      }),
      annotations: expect.arrayContaining([
        {
          name: "org.opencontainers.image.ref.name",
          value: "latest",
        },
      ]),
    }),
  ]);
  expect(report.images).toHaveLength(1);
  const image = report.images[0];
  expect(image).toMatchObject({
    digest: written.manifestDigest,
    config_digest: written.configDigest,
    architecture: "amd64",
    os: "linux",
    user: "nobody",
    entrypoint: ["/bin/sh"],
    cmd: ["-c", "true"],
    working_dir: "/",
    stop_signal: "SIGTERM",
  });
  expect(image?.env).toEqual([
    { name: "PATH", value: "/usr/bin" },
    { name: "SECRET", value: "redact-me" },
  ]);
  expect(image?.exposed_ports).toEqual(["80/tcp"]);
  expect(image?.volumes).toEqual(["/data"]);
  expect(image?.history).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        created_by: "/bin/sh -c #(nop) ADD layer",
        empty_layer: false,
      }),
      expect.objectContaining({
        created_by: "/bin/sh -c #(nop) ENV SECRET=redact-me",
        empty_layer: true,
      }),
    ]),
  );
  expect(image?.layers).toEqual([
    expect.objectContaining({
      digest: written.layerDigest,
      present: true,
    }),
  ]);
  expect(report.findings).toEqual([]);
  expect(report.coverage.status).toBe("complete");
  expect(report.coverage.blobs_hashed).toBeGreaterThanOrEqual(3);
  expect(report.limitations).toEqual(
    expect.arrayContaining([
      OCI_IMAGE_LAYOUT_LIMITATIONS.directoryOnly,
      OCI_IMAGE_LAYOUT_LIMITATIONS.noLayerContents,
    ]),
  );
  expect(report.limitations).not.toContain(
    OCI_IMAGE_LAYOUT_LIMITATIONS.envRedacted,
  );
  const hashed = report.blobs.filter((blob) => blob.hashed);
  expect(hashed.every((blob) => blob.sha256 !== null)).toBe(true);
});

it("preserves significant whitespace in config string facts", async () => {
  const root = await createTestTempDirectory("rea-oci-whitespace-");
  await writeOciImageLayoutFixture(root, {
    config: { workingDir: "/app ", user: " nobody" },
  });
  const report = await inspectLayout(root);
  expect(report.images[0]).toMatchObject({
    working_dir: "/app ",
    user: " nobody",
  });
});

it("omits Env values when include_env_values is false", async () => {
  const root = await createTestTempDirectory("rea-oci-env-");
  await writeOciImageLayoutFixture(root);
  const report = await inspectLayout(root, { include_env_values: false });
  expect(report.images[0]?.env).toEqual([
    { name: "PATH", value: null },
    { name: "SECRET", value: null },
  ]);
  expect(report.limitations).toContain(
    OCI_IMAGE_LAYOUT_LIMITATIONS.envRedacted,
  );
});

it("reads the platform os.version member", async () => {
  const root = await createTestTempDirectory("rea-oci-os-version-");
  await writeOciImageLayoutFixture(root);
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    manifests: { platform: Record<string, string> }[];
  };
  index.manifests[0]!.platform = {
    ...index.manifests[0]!.platform,
    os: "windows",
    "os.version": "10.0.17763.1879",
  };
  await writeFile(indexPath, JSON.stringify(index));
  const report = await inspectLayout(root);
  expect(report.indexes[0]?.entries[0]?.platform).toMatchObject({
    os: "windows",
    os_version: "10.0.17763.1879",
  });
});

it("inventories a multi-platform index", async () => {
  const root = await createTestTempDirectory("rea-oci-multi-");
  const written = await writeMultiPlatformOciImageLayoutFixture(root);
  const report = await inspectLayout(root);
  expect(report.indexes[0]?.entries).toHaveLength(2);
  expect(report.images.map((image) => image.digest).sort()).toEqual(
    [written.amd64, written.arm64].sort(),
  );
  expect(report.images.map((image) => image.architecture).sort()).toEqual([
    "amd64",
    "arm64",
  ]);
  expect(report.findings).toEqual([]);
});

it("records a missing blob as a finding", async () => {
  const root = await createTestTempDirectory("rea-oci-missing-");
  const written = await writeOciImageLayoutFixture(root);
  const parsed = parseOciDigest(written.layerDigest);
  if (parsed === undefined) throw new Error("expected sha256 layer digest");
  await unlink(join(root, "blobs", parsed.algorithm, parsed.hex));
  const report = await inspectLayout(root);
  expect(report.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "missing_blob",
        digest: written.layerDigest,
      }),
    ]),
  );
  expect(report.images[0]?.layers[0]?.present).toBe(false);
  expect(report.coverage.status).toBe("partial");
});

it("records a digest mismatch as a finding", async () => {
  const root = await createTestTempDirectory("rea-oci-mismatch-");
  const written = await writeOciImageLayoutFixture(root);
  const parsed = parseOciDigest(written.layerDigest);
  if (parsed === undefined) throw new Error("expected sha256 layer digest");
  await writeFile(
    join(root, "blobs", parsed.algorithm, parsed.hex),
    "tampered",
  );
  const report = await inspectLayout(root);
  expect(report.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "digest_mismatch",
        digest: written.layerDigest,
      }),
    ]),
  );
  expect(report.coverage.status).toBe("complete");
});

it("records a size mismatch as a finding", async () => {
  const root = await createTestTempDirectory("rea-oci-size-");
  await writeOciImageLayoutFixture(root);
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    manifests: { size: number }[];
  };
  if (index.manifests[0] === undefined)
    throw new Error("expected an index descriptor");
  index.manifests[0].size += 17;
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  const report = await inspectLayout(root);
  expect(report.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "size_mismatch" }),
    ]),
  );
});

it("records a symlinked blob as a finding and does not follow it", async () => {
  const root = await createTestTempDirectory("rea-oci-symlink-");
  const written = await writeOciImageLayoutFixture(root);
  const parsed = parseOciDigest(written.layerDigest);
  if (parsed === undefined) throw new Error("expected sha256 layer digest");
  const blobPath = join(root, "blobs", parsed.algorithm, parsed.hex);
  const target = join(root, "blobs", parsed.algorithm, `${parsed.hex}.real`);
  await writeFile(target, await readFile(blobPath));
  await unlink(blobPath);
  await symlink(target, blobPath);
  const report = await inspectLayout(root);
  expect(report.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "symlink_blob",
        digest: written.layerDigest,
      }),
    ]),
  );
  const blob = report.blobs.find(
    (entry) => entry.digest === written.layerDigest,
  );
  expect(blob).toMatchObject({
    kind: "symlink",
    present: false,
    hashed: false,
  });
});

it("reports partial coverage when a referenced layer is a directory", async () => {
  const root = await createTestTempDirectory("rea-oci-directory-layer-");
  const written = await writeOciImageLayoutFixture(root);
  const parsed = parseOciDigest(written.layerDigest);
  if (parsed === undefined) throw new Error("expected sha256 layer digest");
  const blobPath = join(root, "blobs", parsed.algorithm, parsed.hex);
  await unlink(blobPath);
  await mkdir(blobPath);
  const report = await inspectLayout(root);
  expect(report.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "missing_blob",
        digest: written.layerDigest,
      }),
    ]),
  );
  expect(
    report.blobs.find((entry) => entry.digest === written.layerDigest),
  ).toMatchObject({ kind: "other", present: false, hashed: false });
  expect(report.coverage.status).toBe("partial");
});

it("reports partial coverage when a referenced config is a symlink", async () => {
  const root = await createTestTempDirectory("rea-oci-symlink-config-");
  const written = await writeOciImageLayoutFixture(root);
  const parsed = parseOciDigest(written.configDigest);
  if (parsed === undefined) throw new Error("expected sha256 config digest");
  const blobPath = join(root, "blobs", parsed.algorithm, parsed.hex);
  const target = join(root, "blobs", parsed.algorithm, `${parsed.hex}.real`);
  await writeFile(target, await readFile(blobPath));
  await unlink(blobPath);
  await symlink(target, blobPath);
  const report = await inspectLayout(root);
  expect(report.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "symlink_blob",
        digest: written.configDigest,
      }),
    ]),
  );
  expect(report.coverage.status).toBe("partial");
});

it("refuses an oversize index.json and preserves the oci-layout snapshot", async () => {
  const root = await createTestTempDirectory("rea-oci-oversize-");
  await writeOciImageLayoutFixture(root);
  await writeFile(
    join(root, "index.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [],
      padding: "x".repeat(2000),
    })}\n`,
  );
  const reader = new DirectoryArtifactReader(root);
  try {
    await expect(
      parseOciImageLayout(
        reader,
        inspectOciImageLayoutInputSchema.parse({
          path: root,
          max_json_bytes: 256,
        }),
      ),
    ).rejects.toSatisfy((cause: unknown) => {
      expect(cause).toBeInstanceOf(OciImageLayoutRefusal);
      if (!(cause instanceof OciImageLayoutRefusal)) return false;
      expect(cause.failure.kind).toBe("limit");
      expect(cause.layoutObservation).toMatchObject({
        kind: "file-snapshot-hash",
        path: "oci-layout",
      });
      return true;
    });
  } finally {
    await reader.close();
  }
});

it("refuses an oversize config and preserves the oci-layout snapshot", async () => {
  const root = await createTestTempDirectory("rea-oci-oversize-config-");
  await writeOciImageLayoutFixture(root, {
    config: { labels: { padding: "x".repeat(4000) } },
  });
  const reader = new DirectoryArtifactReader(root);
  try {
    await expect(
      parseOciImageLayout(
        reader,
        inspectOciImageLayoutInputSchema.parse({
          path: root,
          max_json_bytes: 2048,
        }),
      ),
    ).rejects.toSatisfy((cause: unknown) => {
      expect(cause).toBeInstanceOf(OciImageLayoutRefusal);
      if (!(cause instanceof OciImageLayoutRefusal)) return false;
      expect(cause.failure).toMatchObject({
        kind: "limit",
        limit: { name: "max_json_bytes", maximum: 2048 },
      });
      expect(cause.layoutObservation).toMatchObject({
        kind: "file-snapshot-hash",
        path: "oci-layout",
      });
      return true;
    });
  } finally {
    await reader.close();
  }
});

it("refuses an index.json whose manifests is not an array and keeps the oci-layout snapshot", async () => {
  const root = await createTestTempDirectory("rea-oci-index-manifests-type-");
  await writeOciImageLayoutFixture(root);
  await writeFile(
    join(root, "index.json"),
    `${JSON.stringify({ schemaVersion: 2, manifests: "not-an-array" })}\n`,
  );
  const reader = new DirectoryArtifactReader(root);
  try {
    await expect(
      parseOciImageLayout(
        reader,
        inspectOciImageLayoutInputSchema.parse({ path: root }),
      ),
    ).rejects.toSatisfy((cause: unknown) => {
      expect(cause).toBeInstanceOf(OciImageLayoutRefusal);
      if (!(cause instanceof OciImageLayoutRefusal)) return false;
      expect(cause.failure.kind).toBe("malformed");
      expect(cause.layoutObservation).toMatchObject({
        kind: "file-snapshot-hash",
        path: "oci-layout",
      });
      return true;
    });
  } finally {
    await reader.close();
  }
});

it("reports a nested index whose manifests is not an array", async () => {
  const root = await createTestTempDirectory("rea-oci-nested-manifests-type-");
  await writeOciImageLayoutFixture(root);
  const nestedJson = `${JSON.stringify({ schemaVersion: 2, manifests: { digest: "x" } })}\n`;
  const nested = await putOciBlob(root, nestedJson);
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    manifests: unknown[];
  };
  index.manifests.push({
    mediaType: "application/vnd.oci.image.index.v1+json",
    digest: nested,
    size: Buffer.byteLength(nestedJson),
  });
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  const report = await inspectLayout(root);
  expect(report.findings).toContainEqual(
    expect.objectContaining({
      kind: "malformed_blob_json",
      digest: nested,
      message: expect.stringContaining("manifests is not an array"),
    }),
  );
  expect(
    report.indexes.find((entry) => entry.digest === nested)?.entries,
  ).toEqual([]);
  expect(report.coverage.status).toBe("partial");
});

it("reports a manifest whose layers is not an array", async () => {
  const root = await createTestTempDirectory("rea-oci-manifest-layers-type-");
  const written = await writeOciImageLayoutFixture(root);
  const manifestPath = join(
    root,
    "blobs",
    "sha256",
    written.manifestDigest.slice("sha256:".length),
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  manifest.layers = "not-an-array";
  const manifestJson = `${JSON.stringify(manifest)}\n`;
  const manifestDigest = await putOciBlob(root, manifestJson);
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    manifests: { digest: string; size: number }[];
  };
  index.manifests[0] = {
    ...index.manifests[0]!,
    digest: manifestDigest,
    size: Buffer.byteLength(manifestJson),
  };
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  await unlink(manifestPath);
  const report = await inspectLayout(root);
  expect(report.findings).toContainEqual(
    expect.objectContaining({
      kind: "malformed_blob_json",
      digest: manifestDigest,
      message: expect.stringContaining("layers is not an array"),
    }),
  );
  expect(report.images[0]?.layers).toEqual([]);
  expect(report.coverage.status).toBe("partial");
});

it("records nested index depth as a finding once the bound is exceeded", async () => {
  const root = await createTestTempDirectory("rea-oci-nested-");
  await writeNestedOciIndexFixture(root, 2);
  const report = await inspectLayout(root, { max_index_depth: 1 });
  expect(report.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "nested_index_depth_exceeded" }),
    ]),
  );
  expect(report.indexes.every((index) => index.depth <= 1)).toBe(true);
  expect(report.coverage.status).toBe("partial");
});

it("leaves blobs past a truncated index walk unknown instead of unreferenced", async () => {
  const root = await createTestTempDirectory("rea-oci-truncated-walk-");
  const written = await writeOciImageLayoutFixture(root);
  const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
  const index = (manifests: unknown[]) =>
    `${JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests })}\n`;
  const descriptor = async (body: string) => ({
    mediaType: OCI_INDEX,
    digest: await putOciBlob(root, body),
    size: Buffer.byteLength(body),
  });
  // Root -> A -> B -> manifest; depth 1 stops before B.
  const b = await descriptor(
    index([
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: written.manifestDigest,
        size: written.manifestSize,
      },
    ]),
  );
  const a = await descriptor(index([b]));
  await writeFile(join(root, "index.json"), index([a]));
  const report = await inspectLayout(root, { max_index_depth: 1 });
  expect(
    report.findings.filter((finding) => finding.kind === "unreferenced_blob"),
  ).toEqual([]);
  expect(report.blobs.every((blob) => blob.referenced)).toBe(true);
  expect(report.coverage.status).toBe("partial");
  expect(
    report.limitations.some((limitation) =>
      limitation.includes("reference graph was not fully examined"),
    ),
  ).toBe(true);
});

it("inventories an index a deeper path reaches first at its shallowest depth", async () => {
  const root = await createTestTempDirectory("rea-oci-shared-index-");
  const written = await writeOciImageLayoutFixture(root);
  const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
  const index = (manifests: unknown[]) =>
    `${JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests })}\n`;
  const descriptor = async (body: string) => ({
    mediaType: OCI_INDEX,
    digest: await putOciBlob(root, body),
    size: Buffer.byteLength(body),
  });
  // Root lists A then X; A also lists X, and X lists Y, which holds the image.
  const y = await descriptor(
    index([
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: written.manifestDigest,
        size: written.manifestSize,
      },
    ]),
  );
  const x = await descriptor(index([y]));
  const a = await descriptor(index([x]));
  await writeFile(join(root, "index.json"), index([a, x]));
  const report = await inspectLayout(root, { max_index_depth: 2 });
  expect(report.images.map((image) => image.digest)).toEqual([
    written.manifestDigest,
  ]);
  expect(report.indexes.find((entry) => entry.digest === x.digest)?.depth).toBe(
    1,
  );
  expect(
    report.findings.filter(
      (finding) => finding.kind === "nested_index_depth_exceeded",
    ),
  ).toEqual([]);
});

it("checks every declared size of a blob that several manifests share", async () => {
  const root = await createTestTempDirectory("rea-oci-shared-config-");
  const written = await writeOciImageLayoutFixture(root);
  const manifest = JSON.parse(
    await readFile(
      join(root, "blobs", "sha256", written.manifestDigest.slice(7)),
      "utf8",
    ),
  ) as { config: { size: number } };
  const configSize = manifest.config.size;
  // A second manifest reuses the same config blob but declares a wrong size.
  manifest.config.size = configSize + 1;
  const second = `${JSON.stringify(manifest)}\n`;
  const secondDigest = await putOciBlob(root, second);
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    manifests: unknown[];
  };
  index.manifests.push({
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: secondDigest,
    size: Buffer.byteLength(second),
  });
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  const report = await inspectLayout(root);
  const mismatches = report.findings.filter(
    (finding) =>
      finding.kind === "size_mismatch" &&
      finding.digest === written.configDigest,
  );
  expect(mismatches.length).toBeGreaterThan(0);
  expect(
    mismatches.every((finding) =>
      finding.message.includes(String(configSize + 1)),
    ),
  ).toBe(true);
});

it("reports a blob above 4 GiB as blob_oversize in a valid report", async () => {
  const root = await createTestTempDirectory("rea-oci-huge-declared-");
  const written = await writeOciImageLayoutFixture(root);
  const manifest = JSON.parse(
    await readFile(
      join(root, "blobs", "sha256", written.manifestDigest.slice(7)),
      "utf8",
    ),
  ) as { layers: { digest: string; size: number }[] };
  const layer = manifest.layers[0];
  if (layer === undefined) throw new Error("fixture has no layer");
  const declared = 5 * 1024 * 1024 * 1024;
  layer.size = declared;
  const text = `${JSON.stringify(manifest)}\n`;
  const digest = await putOciBlob(root, text);
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    manifests: { digest: string; size: number }[];
  };
  const entry = index.manifests[0];
  if (entry === undefined) throw new Error("fixture has no manifest");
  entry.digest = digest;
  entry.size = Buffer.byteLength(text);
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  // Sparse file: the reader sees the 5 GiB size without the bytes being written.
  await truncate(
    join(root, "blobs", "sha256", layer.digest.slice(7)),
    declared,
  );
  const report = await inspectLayout(root);
  expect(report.findings).toContainEqual(
    expect.objectContaining({ kind: "blob_oversize", digest: layer.digest }),
  );
  expect(report.blobs).toContainEqual(
    expect.objectContaining({
      digest: layer.digest,
      declared_size: declared,
      observed_size: declared,
      hashed: false,
    }),
  );
  expect(report.images[0]?.layers).toContainEqual(
    expect.objectContaining({ digest: layer.digest, size: declared }),
  );
});

it("refuses malformed index.json and preserves the oci-layout snapshot", async () => {
  const root = await createTestTempDirectory("rea-oci-malformed-");
  await writeOciImageLayoutFixture(root);
  await writeFile(join(root, "index.json"), "{not-json");
  const reader = new DirectoryArtifactReader(root);
  try {
    await expect(
      parseOciImageLayout(
        reader,
        inspectOciImageLayoutInputSchema.parse({ path: root }),
      ),
    ).rejects.toSatisfy((cause: unknown) => {
      expect(cause).toBeInstanceOf(OciImageLayoutRefusal);
      if (!(cause instanceof OciImageLayoutRefusal)) return false;
      expect(cause.failure.kind).toBe("malformed");
      expect(cause.layoutObservation).toMatchObject({
        kind: "file-snapshot-hash",
        path: "oci-layout",
      });
      return true;
    });
  } finally {
    await reader.close();
  }
});

it("records unreferenced blobs, unknown media types and unsupported digests", async () => {
  const root = await createTestTempDirectory("rea-oci-findings-");
  await writeOciImageLayoutFixture(root);
  const orphan = await putOciBlob(root, "orphan-blob");
  await putOciBlob(root, "unreferenced-blob");
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    manifests: Record<string, unknown>[];
  };
  index.manifests.push(
    {
      mediaType: "application/vnd.example.unknown",
      digest: orphan,
      size: 11,
    },
    {
      mediaType: "application/vnd.oci.image.layer.v1.tar",
      digest: "sha1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      size: 4,
    },
  );
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  const report = await inspectLayout(root);
  expect(report.findings.map((finding) => finding.kind)).toEqual(
    expect.arrayContaining([
      "unknown_media_type",
      "unsupported_digest_algorithm",
      "unreferenced_blob",
    ]),
  );
});

it("treats a blob named by an uppercase-hex descriptor as referenced", async () => {
  const root = await createTestTempDirectory("rea-oci-uppercase-");
  await writeOciImageLayoutFixture(root);
  const blob = await putOciBlob(root, "uppercase-blob");
  const parsed = parseOciDigest(blob);
  if (parsed === undefined) throw new Error("expected sha256 blob digest");
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    manifests: Record<string, unknown>[];
  };
  index.manifests.push({
    mediaType: "application/vnd.example.unknown",
    digest: `sha256:${parsed.hex.toUpperCase()}`,
    size: 14,
  });
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  const report = await inspectLayout(root);
  const path = `blobs/sha256/${parsed.hex}`;
  expect(
    report.findings.filter((finding) => finding.kind === "unreferenced_blob"),
  ).toEqual([]);
  const rows = report.blobs.filter((entry) => entry.path === path);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.referenced).toBe(true);
});

it("reports a descriptor it cannot model instead of dropping it silently", async () => {
  const root = await createTestTempDirectory("rea-oci-malformed-descriptor-");
  await writeOciImageLayoutFixture(root);
  const orphan = await putOciBlob(root, "descriptor-without-media-type");
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    manifests: unknown[];
  };
  index.manifests.push({ digest: orphan, size: 29 }, "not-a-descriptor");
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  const report = await inspectLayout(root);
  const malformed = report.findings.filter(
    (finding) => finding.kind === "malformed_blob_json",
  );
  expect(malformed.map((finding) => finding.message)).toEqual([
    expect.stringContaining(
      `manifests[1] lacks a string mediaType (digest ${orphan})`,
    ),
    expect.stringContaining("manifests[2] is not a JSON object"),
  ]);
  expect(report.indexes[0]?.entries).toHaveLength(1);
});

it("reports an unsupported layer digest without claiming the blob is missing", async () => {
  const root = await createTestTempDirectory("rea-oci-sha1-layer-");
  const written = await writeOciImageLayoutFixture(root);
  const hex = "a".repeat(40);
  await mkdir(join(root, "blobs", "sha1"), { recursive: true });
  await writeFile(join(root, "blobs", "sha1", hex), "layer");
  const manifestPath = join(
    root,
    "blobs",
    "sha256",
    written.manifestDigest.slice("sha256:".length),
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    layers: unknown[];
  };
  manifest.layers.push({
    mediaType: "application/vnd.oci.image.layer.v1.tar",
    digest: `sha1:${hex}`,
    size: 5,
  });
  const manifestJson = `${JSON.stringify(manifest)}\n`;
  const manifestDigest = await putOciBlob(root, manifestJson);
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    manifests: { digest: string; size: number }[];
  };
  index.manifests[0] = {
    ...index.manifests[0]!,
    digest: manifestDigest,
    size: Buffer.byteLength(manifestJson),
  };
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  await unlink(manifestPath);
  const report = await inspectLayout(root);
  expect(report.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "unsupported_digest_algorithm",
        digest: `sha1:${hex}`,
      }),
    ]),
  );
  expect(
    report.findings.some(
      (finding) =>
        finding.digest === `sha1:${hex}` &&
        (finding.kind === "missing_blob" ||
          finding.kind === "unreferenced_blob"),
    ),
  ).toBe(false);
  expect(
    report.blobs.find((blob) => blob.digest === `sha1:${hex}`),
  ).toMatchObject({
    path: `blobs/sha1/${hex}`,
    kind: "file",
    present: true,
    hashed: false,
  });
  expect(report.coverage.status).toBe("partial");
});

it("refuses a missing oci-layout as malformed input", async () => {
  const root = await createTestTempDirectory("rea-oci-empty-");
  await mkdir(root, { recursive: true });
  const reader = new DirectoryArtifactReader(root);
  try {
    await expect(
      parseOciImageLayout(
        reader,
        inspectOciImageLayoutInputSchema.parse({ path: root }),
      ),
    ).rejects.toBeInstanceOf(ParseFailureError);
  } finally {
    await reader.close();
  }
});

it("projects a non-directory selection as an unsupported target", async () => {
  const root = await createTestTempDirectory("rea-oci-file-");
  const path = join(root, "not-a-layout");
  await writeFile(path, "not a directory");
  const provider = new OciImageLayoutProvider();
  try {
    const result = await provider.inspect(
      inspectOciImageLayoutInputSchema.parse({ path }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatchObject({
        _tag: "AnalysisUnsupportedTargetError",
      });
  } finally {
    await provider.close();
  }
});

it("keeps the parse refusal and its layout snapshot when reader cleanup also fails", async () => {
  const root = await createTestTempDirectory("rea-oci-cleanup-");
  await writeOciImageLayoutFixture(root);
  await writeFile(
    join(root, "index.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [],
      padding: "x".repeat(2000),
    })}\n`,
  );
  const nativeClose = DirectoryArtifactReader.prototype.close;
  let attempts = 0;
  const close = vi
    .spyOn(DirectoryArtifactReader.prototype, "close")
    .mockImplementation(async function (this: DirectoryArtifactReader) {
      attempts++;
      if (attempts === 1) throw new Error("controlled close failure");
      await nativeClose.call(this);
    });
  const provider = new OciImageLayoutProvider();
  try {
    const result = await provider.inspect(
      inspectOciImageLayoutInputSchema.parse({
        path: root,
        max_json_bytes: 256,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.cleanupIncomplete).toBe(true);
    const primary = primaryAnalysisError(result.error);
    expect(primary.message).toContain("index.json exceeds the 256-byte budget");
    expect(primary.partialObservation).toMatchObject({
      kind: "file-snapshot-hash",
      path: "oci-layout",
    });
  } finally {
    close.mockRestore();
    await provider.close();
  }
});

it("keeps the completed inventory when reader cleanup fails, then retries cleanup", async () => {
  const root = await createTestTempDirectory("rea-oci-cleanup-completed-");
  await writeOciImageLayoutFixture(root);
  const nativeClose = DirectoryArtifactReader.prototype.close;
  let attempts = 0;
  const close = vi
    .spyOn(DirectoryArtifactReader.prototype, "close")
    .mockImplementation(async function (this: DirectoryArtifactReader) {
      attempts++;
      if (attempts === 1) throw new Error("controlled close failure");
      await nativeClose.call(this);
    });
  const provider = new OciImageLayoutProvider();
  try {
    const result = await provider.inspect(
      inspectOciImageLayoutInputSchema.parse({ path: root }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.cleanupIncomplete).toBe(true);
    const report = ociImageLayoutSchema.parse(
      parseEvidence(result.error.partialObservation).normalized_result,
    );
    expect(report.artifact.path).toBe(root);
    expect(report.images.length).toBeGreaterThan(0);
    await provider.close();
    expect(attempts).toBe(2);
  } finally {
    close.mockRestore();
    await provider.close();
  }
});

it("keeps the oci-layout snapshot when imageLayoutVersion is missing", async () => {
  const root = await createTestTempDirectory("rea-oci-no-version-");
  await writeOciImageLayoutFixture(root);
  await writeFile(join(root, "oci-layout"), "{}\n");
  const provider = new OciImageLayoutProvider();
  try {
    const result = await provider.inspect(
      inspectOciImageLayoutInputSchema.parse({ path: root }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const primary = primaryAnalysisError(result.error);
    expect(JSON.stringify(primary)).toContain("missing imageLayoutVersion");
    expect(primary.partialObservation).toMatchObject({
      kind: "file-snapshot-hash",
      path: "oci-layout",
      bytes: 3,
    });
  } finally {
    await provider.close();
  }
});

it("keeps the directory reader's unknown coverage and its limitation", async () => {
  const root = await createTestTempDirectory("rea-oci-traversal-coverage-");
  await writeOciImageLayoutFixture(root);
  const skipped =
    "Directory contains 1 entry name(s) that are not valid UTF-8; no filesystem operations were performed for them.";
  class SkippingReader extends DirectoryArtifactReader {
    override async *entries(
      ...args: Parameters<DirectoryArtifactReader["entries"]>
    ): ReturnType<DirectoryArtifactReader["entries"]> {
      const [signal, selection] = args;
      const options =
        typeof selection === "function"
          ? { descendInto: selection }
          : selection;
      yield* super.entries(signal, { ...options, onCoverage: () => undefined });
      options?.onCoverage?.({ status: "unknown", limitations: [skipped] });
    }
  }
  const reader = new SkippingReader(root);
  try {
    const report = ociImageLayoutSchema.parse(
      await parseOciImageLayout(
        reader,
        inspectOciImageLayoutInputSchema.parse({ path: root }),
      ),
    );
    expect(report.coverage.status).toBe("unknown");
    expect(report.limitations).toContain(skipped);
  } finally {
    await reader.close();
  }
});

it("keeps unknown coverage when the reader omits a non-file blob entry", async () => {
  const root = await createTestTempDirectory("rea-oci-traversal-omission-");
  await writeOciImageLayoutFixture(root);
  class OmittingReader extends DirectoryArtifactReader {
    override async *entries(
      ...args: Parameters<DirectoryArtifactReader["entries"]>
    ): ReturnType<DirectoryArtifactReader["entries"]> {
      const [signal, selection] = args;
      const options =
        typeof selection === "function"
          ? { descendInto: selection }
          : selection;
      options?.onOmission?.({ path: "blobs/sha256/pipe", kind: "fifo" });
      yield* super.entries(signal, options);
    }
  }
  const reader = new OmittingReader(root);
  try {
    const report = ociImageLayoutSchema.parse(
      await parseOciImageLayout(
        reader,
        inspectOciImageLayoutInputSchema.parse({ path: root }),
      ),
    );
    expect(report.coverage.status).toBe("unknown");
    expect(
      report.limitations.some((limitation) =>
        limitation.includes("blobs/sha256/pipe (fifo)"),
      ),
    ).toBe(true);
  } finally {
    await reader.close();
  }
});

it("keeps a reader failure on a referenced blob instead of a JSON finding", async () => {
  const root = await createTestTempDirectory("rea-oci-blob-close-");
  const written = await writeOciImageLayoutFixture(root);
  const manifestHex = written.manifestDigest.slice("sha256:".length);
  const nativeInspect = DirectoryArtifactReader.prototype.inspectFile;
  const failure = new ArtifactReaderFailure("io", "controlled close failure");
  const inspectFile = vi
    .spyOn(DirectoryArtifactReader.prototype, "inspectFile")
    .mockImplementation(async function (
      this: DirectoryArtifactReader,
      ...args: Parameters<DirectoryArtifactReader["inspectFile"]>
    ) {
      const value: unknown = await nativeInspect.apply(this, args);
      if (args[0].path.endsWith(manifestHex)) throw failure;
      return value;
    });
  try {
    await expect(inspectLayout(root)).rejects.toBe(failure);
  } finally {
    inspectFile.mockRestore();
  }
});

const writeSharedLayerLayout = async (
  root: string,
  manifestCount: number,
  layerCount: number,
): Promise<void> => {
  const config = `${JSON.stringify({
    architecture: "amd64",
    os: "linux",
    rootfs: { type: "layers", diff_ids: [] },
  })}\n`;
  const configDigest = await putOciBlob(root, config);
  const layers = [];
  for (let layer = 0; layer < layerCount; layer += 1) {
    const body = `shared-layer-${String(layer)}`;
    layers.push({
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
      digest: await putOciBlob(root, body),
      size: Buffer.byteLength(body),
    });
  }
  const manifests = [];
  for (let image = 0; image < manifestCount; image += 1) {
    const manifest = `${JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: configDigest,
        size: Buffer.byteLength(config),
      },
      layers,
      annotations: { "org.opencontainers.image.ref.name": `v${String(image)}` },
    })}\n`;
    manifests.push({
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: await putOciBlob(root, manifest),
      size: Buffer.byteLength(manifest),
    });
  }
  await writeFile(
    join(root, "index.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests,
    })}\n`,
  );
  await writeFile(
    join(root, "oci-layout"),
    `${JSON.stringify({ imageLayoutVersion: "1.0.0" })}\n`,
  );
};

it("keeps descriptors of shared layers off the directory-entry budget", async () => {
  const root = await createTestTempDirectory("rea-oci-shared-layers-");
  // 50 manifests x 100 shared layers decode over 5,000 descriptors from
  // about 160 directory entries, past the 4096 max_entries default.
  await writeSharedLayerLayout(root, 50, 100);
  const report = await inspectLayout(root);
  expect(report.images).toHaveLength(50);
  expect(report.coverage.status).toBe("complete");
  expect(report.coverage.entries_examined).toBeLessThan(200);
});

it("refuses a layout past max_descriptors and names that allowance", async () => {
  const root = await createTestTempDirectory("rea-oci-descriptors-");
  await writeSharedLayerLayout(root, 5, 10);
  const reader = new DirectoryArtifactReader(root);
  try {
    await expect(
      parseOciImageLayout(
        reader,
        inspectOciImageLayoutInputSchema.parse({
          path: root,
          max_descriptors: 20,
        }),
      ),
    ).rejects.toSatisfy((cause: unknown) => {
      expect(cause).toBeInstanceOf(OciImageLayoutRefusal);
      if (!(cause instanceof OciImageLayoutRefusal)) return false;
      expect(cause.failure).toMatchObject({
        kind: "limit",
        limit: { name: "max_descriptors", maximum: 20, required: 21 },
      });
      expect(cause.layoutObservation).toMatchObject({
        kind: "file-snapshot-hash",
        path: "oci-layout",
      });
      return true;
    });
  } finally {
    await reader.close();
  }
  const provider = new OciImageLayoutProvider();
  try {
    const result = await provider.inspect(
      inspectOciImageLayoutInputSchema.parse({
        path: root,
        max_descriptors: 20,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const primary = primaryAnalysisError(result.error);
    expect(JSON.stringify(primary)).toContain("max_descriptors");
    expect(primary.partialObservation).toMatchObject({
      kind: "file-snapshot-hash",
      path: "oci-layout",
    });
  } finally {
    await provider.close();
  }
});

it("reads a config shared by many manifests once", async () => {
  const root = await createTestTempDirectory("rea-oci-shared-config-");
  await writeSharedLayerLayout(root, 5, 1);
  const blobBytes = async (digest: string): Promise<number> => {
    const parsed = parseOciDigest(digest);
    if (parsed === undefined) throw new Error(`bad digest ${digest}`);
    return (await readFile(join(root, "blobs", parsed.algorithm, parsed.hex)))
      .length;
  };
  const index = JSON.parse(
    await readFile(join(root, "index.json"), "utf8"),
  ) as { manifests: { digest: string }[] };
  let expected =
    (await readFile(join(root, "oci-layout"))).length +
    (await readFile(join(root, "index.json"))).length;
  for (const manifest of index.manifests)
    expected += await blobBytes(manifest.digest);
  const report = await inspectLayout(root);
  expect(report.images).toHaveLength(5);
  const configDigest = report.images[0]?.config_digest;
  expect(configDigest).toBeTypeOf("string");
  expect(
    report.images.every((image) => image.config_digest === configDigest),
  ).toBe(true);
  expected += await blobBytes(configDigest!);
  expect(report.coverage.json_bytes_read).toBe(expected);
});

it("refuses a layout whose shared config expands past max_config_bytes", async () => {
  const root = await createTestTempDirectory("rea-oci-config-bytes-");
  await writeSharedLayerLayout(root, 5, 1);
  const configBytes = Buffer.byteLength(
    `${JSON.stringify({
      architecture: "amd64",
      os: "linux",
      rootfs: { type: "layers", diff_ids: [] },
    })}\n`,
  );
  const maximum = configBytes * 2;
  const reader = new DirectoryArtifactReader(root);
  try {
    await expect(
      parseOciImageLayout(
        reader,
        inspectOciImageLayoutInputSchema.parse({
          path: root,
          max_config_bytes: maximum,
        }),
      ),
    ).rejects.toSatisfy((cause: unknown) => {
      expect(cause).toBeInstanceOf(ParseFailureError);
      if (!(cause instanceof ParseFailureError)) return false;
      expect(cause.failure).toMatchObject({
        kind: "limit",
        limit: {
          name: "max_config_bytes",
          maximum,
          required: configBytes * 3,
        },
      });
      return true;
    });
  } finally {
    await reader.close();
  }
  const provider = new OciImageLayoutProvider();
  try {
    const result = await provider.inspect(
      inspectOciImageLayoutInputSchema.parse({
        path: root,
        max_config_bytes: maximum,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(primaryAnalysisError(result.error))).toContain(
      "max_config_bytes",
    );
  } finally {
    await provider.close();
  }
});
