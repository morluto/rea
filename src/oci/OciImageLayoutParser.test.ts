import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { fstatSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import {
  inspectOciImageLayoutInputSchema,
  ociImageLayoutSchema,
  parseOciDigest,
} from "../domain/oci/imageLayout.js";
import { jsonByteLength } from "../domain/jsonSerialization.js";
import { ParseFailureError } from "../domain/parseFailure.js";
import { primaryAnalysisError } from "../domain/analysisErrorBase.js";
import { parseEvidence } from "../domain/evidence.js";
import {
  AnalysisCleanupLease,
  ArtifactFileCancelled,
  ArtifactFileCleanupFailure,
  ArtifactReaderFailure,
  DirectoryArtifactReader,
} from "../resources/index.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";
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
  // The layer was not hashed, so the inventory is not complete.
  expect(report.coverage.status).toBe("partial");
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

it.each([["blobs"], ["blobs/sha256"]])(
  "reports a symlinked %s directory as unexamined, not empty",
  async (linked) => {
    const root = await createTestTempDirectory("rea-oci-symlink-blob-dir-");
    await writeOciImageLayoutFixture(root);
    await writeFile(
      join(root, "index.json"),
      `${JSON.stringify({ schemaVersion: 2, manifests: [] })}\n`,
    );
    const linkPath = join(root, ...linked.split("/"));
    const target = join(root, "elsewhere");
    await rename(linkPath, target);
    await symlink(target, linkPath);
    const report = await inspectLayout(root);
    expect(report.findings).toContainEqual({
      kind: "symlink_blob",
      digest: null,
      path: linked,
      message: `Blob directory ${linked} is a symlink and was not followed; blobs under it are not inventoried.`,
    });
    expect(report.coverage.status).toBe("partial");
  },
);

it.each([
  [
    "annotations",
    { bad: false },
    "annotations has 1 value that is not a string; it is omitted",
  ],
  ["annotations", ["x"], "annotations is not a JSON object; it is not modeled"],
  ["platform", [], "platform is not a JSON object; it is not modeled"],
  [
    "platform",
    { os: 7, architecture: "amd64" },
    "platform os is not a string; it is omitted",
  ],
])(
  "reports malformed index entry %s %j and keeps the entry",
  async (member, value, defect) => {
    const root = await createTestTempDirectory("rea-oci-descriptor-meta-");
    await writeOciImageLayoutFixture(root);
    const indexPath = join(root, "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8")) as {
      manifests: Record<string, unknown>[];
    };
    const entry = index.manifests[0];
    if (entry === undefined) throw new Error("fixture has no manifest");
    entry[member] = value;
    await writeFile(indexPath, `${JSON.stringify(index)}\n`);
    const report = await inspectLayout(root);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        kind: "malformed_blob_json",
        message: expect.stringContaining(`manifests[0] ${defect}.`),
      }),
    );
    expect(report.indexes[0]?.entries).toHaveLength(1);
    expect(report.coverage.status).toBe("partial");
  },
);

it("keeps readable index entry annotations and platform without findings", async () => {
  const root = await createTestTempDirectory("rea-oci-descriptor-meta-ok-");
  await writeOciImageLayoutFixture(root);
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    manifests: Record<string, unknown>[];
  };
  const entry = index.manifests[0];
  if (entry === undefined) throw new Error("fixture has no manifest");
  entry.annotations = { "org.example": "kept" };
  entry.platform = { os: "linux", architecture: "amd64" };
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  const report = await inspectLayout(root);
  expect(report.findings).toEqual([]);
  expect(report.indexes[0]?.entries[0]).toMatchObject({
    annotations: [{ name: "org.example", value: "kept" }],
    platform: { os: "linux", architecture: "amd64" },
  });
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

it("keeps a non-image config as an opaque hashed reference", async () => {
  const root = await createTestTempDirectory("rea-oci-opaque-config-");
  await writeOciImageLayoutFixture(root);
  const configBytes = Buffer.alloc(4096, 0xff);
  const configDigest = await putOciBlob(root, configBytes);
  const layerDigest = await putOciBlob(root, "artifact-layer");
  const manifestJson = `${JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    artifactType: "application/vnd.example.artifact",
    config: {
      mediaType: "application/octet-stream",
      digest: configDigest,
      size: configBytes.length,
    },
    layers: [
      {
        mediaType: "application/vnd.oci.image.layer.v1.tar",
        digest: layerDigest,
        size: 14,
      },
    ],
  })}\n`;
  const manifestDigest = await putOciBlob(root, manifestJson);
  await writeFile(
    join(root, "index.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: manifestDigest,
          size: Buffer.byteLength(manifestJson),
        },
      ],
    })}\n`,
  );
  const report = await inspectLayout(root, { max_json_bytes: 2048 });
  expect(report.images).toHaveLength(1);
  expect(report.images[0]).toMatchObject({
    digest: manifestDigest,
    config_digest: configDigest,
    architecture: null,
    os: null,
  });
  expect(
    report.findings.filter((finding) => finding.digest === configDigest),
  ).toEqual([
    expect.objectContaining({
      kind: "unknown_media_type",
      digest: configDigest,
    }),
  ]);
  const parsed = parseOciDigest(configDigest);
  if (parsed === undefined) throw new Error("expected sha256 config digest");
  const row = report.blobs.find(
    (entry) => entry.path === `blobs/sha256/${parsed.hex}`,
  );
  expect(row).toMatchObject({ referenced: true, hashed: true });
  expect(report.coverage.status).toBe("complete");
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

it("bounds a long repeated member name in a referenced blob finding", async () => {
  const root = await createTestTempDirectory("rea-oci-duplicate-member-");
  await writeOciImageLayoutFixture(root);
  const name = "n".repeat(8192);
  const nestedJson = `{"schemaVersion":2,"manifests":[],"${name}":1,"${name}":2}\n`;
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
  const finding = report.findings.find(
    (entry) => entry.kind === "malformed_blob_json" && entry.digest === nested,
  );
  expect(finding?.message).toContain(
    "repeats object member (a 8192-character name)",
  );
  expect(finding?.message.length).toBeLessThan(512);
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

it.each([["[]"], ["null"]])(
  "reports a config whose root is %s and keeps the manifest layers",
  async (configJson) => {
    const root = await createTestTempDirectory("rea-oci-config-root-type-");
    const written = await writeOciImageLayoutFixture(root);
    const configDigest = await putOciBlob(root, configJson);
    const manifestPath = join(
      root,
      "blobs",
      "sha256",
      written.manifestDigest.slice("sha256:".length),
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      config: { digest: string; size: number };
    };
    manifest.config = {
      ...manifest.config,
      digest: configDigest,
      size: Buffer.byteLength(configJson),
    };
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
        digest: configDigest,
        message: expect.stringContaining("root is not a JSON object"),
      }),
    );
    expect(report.images[0]?.config_digest).toBe(configDigest);
    expect(report.images[0]?.layers).toEqual([
      expect.objectContaining({ digest: written.layerDigest, present: true }),
    ]);
    expect(report.coverage.status).toBe("partial");
  },
);

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
  // B is named by A, so it stays referenced; the manifest graph below B was
  // never walked, so its blobs keep their rows with an unknown status.
  const rowOf = (digest: string) =>
    report.blobs.find((blob) => blob.digest === digest);
  expect(rowOf(b.digest)?.referenced).toBe(true);
  expect(rowOf(written.manifestDigest)).toMatchObject({
    referenced: null,
    present: true,
    kind: "file",
  });
  const unknown = report.blobs.filter((blob) => blob.referenced === null);
  expect(unknown).toHaveLength(3);
  expect(report.blobs.some((blob) => blob.referenced === false)).toBe(false);
  for (const blob of unknown)
    expect(blob).toMatchObject({ present: true, kind: "file", hashed: false });
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

it.each([
  ["a string", "5", 'size "5" is not a non-negative integer'],
  ["a negative number", -1, "size -1 is not a non-negative integer"],
  ["a fraction", 1.5, "size 1.5 is not a non-negative integer"],
  ["missing", undefined, "lacks a size"],
])(
  "reports a layer size that is %s as malformed and keeps the layer",
  async (_label, size, defect) => {
    const root = await createTestTempDirectory("rea-oci-bad-size-");
    const written = await writeOciImageLayoutFixture(root);
    const manifest = JSON.parse(
      await readFile(
        join(root, "blobs", "sha256", written.manifestDigest.slice(7)),
        "utf8",
      ),
    ) as { layers: Record<string, unknown>[] };
    const layer = manifest.layers[0];
    if (layer === undefined) throw new Error("fixture has no layer");
    if (size === undefined) delete layer.size;
    else layer.size = size;
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
    const report = await inspectLayout(root);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        kind: "malformed_blob_json",
        digest,
        message: expect.stringContaining(`layers[0] ${defect}`),
      }),
    );
    expect(report.images[0]?.layers).toContainEqual(
      expect.objectContaining({ digest: layer.digest, size: null }),
    );
    expect(report.coverage.status).toBe("partial");
  },
);

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

it("records unknown media types and unsupported digests", async () => {
  const root = await createTestTempDirectory("rea-oci-findings-");
  await writeOciImageLayoutFixture(root);
  const orphan = await putOciBlob(root, "orphan-blob");
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
    ]),
  );
});

it("keeps reference status unknown when an index entry is opaque", async () => {
  const root = await createTestTempDirectory("rea-oci-opaque-entry-");
  await writeOciImageLayoutFixture(root);
  const opaque = await putOciBlob(root, "opaque-document");
  const child = await putOciBlob(root, "child-of-opaque");
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    manifests: Record<string, unknown>[];
  };
  index.manifests.push({
    mediaType: "application/vnd.example.unknown",
    digest: opaque,
    size: 15,
  });
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  const report = await inspectLayout(root);
  expect(report.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "unknown_media_type", digest: opaque }),
    ]),
  );
  expect(
    report.findings.some((finding) => finding.kind === "unreferenced_blob"),
  ).toBe(false);
  expect(
    report.blobs.find((entry) => entry.digest === child)?.referenced,
  ).toBeNull();
  expect(
    report.blobs.find((entry) => entry.digest === opaque)?.referenced,
  ).toBe(true);
  expect(report.coverage.status).toBe("partial");
});

const OCI_EMPTY_CONFIG = {
  mediaType: "application/vnd.oci.empty.v1+json",
  size: 2,
};

/** A manifest with a config and one layer, as written bytes. */
const putLayerManifest = async (
  root: string,
  layerBody: string,
  options: { configBody?: string; subject?: unknown } = {},
): Promise<{
  digest: string;
  config: string;
  layer: string;
  json: string;
}> => {
  const configBody = options.configBody ?? "{}";
  const config = await putOciBlob(root, configBody);
  const layer = await putOciBlob(root, layerBody);
  const json = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config:
      options.configBody === undefined
        ? { ...OCI_EMPTY_CONFIG, digest: config }
        : {
            mediaType: "application/vnd.oci.image.config.v1+json",
            digest: config,
            size: Buffer.byteLength(configBody),
          },
    layers: [
      {
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        digest: layer,
        size: Buffer.byteLength(layerBody),
      },
    ],
    ...(options.subject === undefined ? {} : { subject: options.subject }),
  });
  return { digest: await putOciBlob(root, json), config, layer, json };
};

/** An index whose manifests are `entries`, as written bytes. */
const putIndex = async (
  root: string,
  entries: unknown[],
  subject?: unknown,
): Promise<{ digest: string; json: string }> => {
  const json = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: entries,
    ...(subject === undefined ? {} : { subject }),
  });
  return { digest: await putOciBlob(root, json), json };
};

it("walks local subjects as references and hashes them", async () => {
  const root = await createTestTempDirectory("rea-oci-subject-");
  await writeOciImageLayoutFixture(root);
  const manifestSubject = await putLayerManifest(root, "manifest-subject");
  const nested = await putLayerManifest(root, "index-subject-entry");
  const indexSubject = await putIndex(root, [
    {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: nested.digest,
      size: Buffer.byteLength(nested.json),
    },
  ]);
  const emptyConfig = await putOciBlob(root, "{}");
  const referrer = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    artifactType: "application/vnd.example.sbom",
    config: { ...OCI_EMPTY_CONFIG, digest: emptyConfig },
    layers: [],
    subject: {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: manifestSubject.digest,
      size: Buffer.byteLength(manifestSubject.json),
    },
  });
  const referrerDigest = await putOciBlob(root, referrer);
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    manifests: Record<string, unknown>[];
    subject?: Record<string, unknown>;
  };
  index.manifests.push({
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: referrerDigest,
    size: Buffer.byteLength(referrer),
  });
  index.subject = {
    mediaType: "application/vnd.oci.image.index.v1+json",
    digest: indexSubject.digest,
    size: Buffer.byteLength(indexSubject.json),
  };
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  const report = await inspectLayout(root);
  expect(report.findings).toEqual([]);
  for (const digest of [
    manifestSubject.digest,
    manifestSubject.layer,
    indexSubject.digest,
    nested.digest,
    nested.layer,
  ]) {
    const row = report.blobs.find((entry) => entry.digest === digest);
    expect(row?.referenced).toBe(true);
    expect(row?.hashed).toBe(true);
    expect(row?.sha256).toBe(digest.slice("sha256:".length));
  }
  expect(report.images.map((image) => image.digest)).toEqual(
    expect.arrayContaining([manifestSubject.digest, nested.digest]),
  );
  expect(
    report.indexes.find((entry) => entry.digest === indexSubject.digest)?.depth,
  ).toBe(1);
  expect(report.coverage.status).toBe("complete");
});

it("reports a subject whose digest is not a valid OCI digest", async () => {
  const root = await createTestTempDirectory("rea-oci-bad-subject-");
  await writeOciImageLayoutFixture(root);
  const badSubject = {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: "not-a-digest",
    size: 1,
  };
  const manifest = await putLayerManifest(root, "bad-subject-layer", {
    subject: badSubject,
  });
  const nested = await putIndex(
    root,
    [
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: manifest.digest,
        size: Buffer.byteLength(manifest.json),
      },
    ],
    badSubject,
  );
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    manifests: Record<string, unknown>[];
  };
  index.manifests.push({
    mediaType: "application/vnd.oci.image.index.v1+json",
    digest: nested.digest,
    size: Buffer.byteLength(nested.json),
  });
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  const report = await inspectLayout(root);
  for (const owner of [manifest.digest, nested.digest])
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        kind: "malformed_blob_json",
        message: expect.stringContaining(
          `${owner} subject digest "not-a-digest" is not a valid OCI digest`,
        ),
      }),
    );
  expect(report.images.map((image) => image.digest)).toContain(
    manifest.digest,
  );
  expect(
    report.blobs.find((entry) => entry.digest === manifest.layer)?.referenced,
  ).toBe(true);
  expect(report.coverage.status).not.toBe("complete");
});

it("walks a chain of manifest subjects iteratively in owner-first order", async () => {
  const root = await createTestTempDirectory("rea-oci-subject-chain-");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "oci-layout"),
    `${JSON.stringify({ imageLayoutVersion: "1.0.0" })}\n`,
  );
  const manifestDescriptor = (manifest: { digest: string; json: string }) => ({
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: manifest.digest,
    size: Buffer.byteLength(manifest.json),
  });
  const configFor = (architecture: string) =>
    JSON.stringify({
      architecture,
      os: "linux",
      rootfs: { type: "layers", diff_ids: [] },
    });
  const m3 = await putLayerManifest(root, "chain-layer-3", {
    configBody: configFor("riscv64"),
  });
  const m2 = await putLayerManifest(root, "chain-layer-2", {
    configBody: configFor("arm64"),
    subject: manifestDescriptor(m3),
  });
  const m1 = await putLayerManifest(root, "chain-layer-1", {
    configBody: configFor("amd64"),
    subject: manifestDescriptor(m2),
  });
  await writeFile(
    join(root, "index.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [manifestDescriptor(m1)],
    })}\n`,
  );
  const report = await inspectLayout(root);
  expect(report.findings).toEqual([]);
  expect(report.coverage.status).toBe("complete");
  expect(report.images.map((image) => image.digest)).toEqual([
    m1.digest,
    m2.digest,
    m3.digest,
  ]);
  expect(report.images.map((image) => image.architecture)).toEqual([
    "amd64",
    "arm64",
    "riscv64",
  ]);
  for (const manifest of [m1, m2, m3]) {
    for (const digest of [manifest.digest, manifest.config, manifest.layer]) {
      const row = report.blobs.find((entry) => entry.digest === digest);
      expect(row).toMatchObject({
        referenced: true,
        hashed: true,
        sha256: digest.slice("sha256:".length),
      });
    }
  }
});

it("keeps a present subject index within max_index_depth", async () => {
  const root = await createTestTempDirectory("rea-oci-subject-depth-");
  await writeOciImageLayoutFixture(root);
  const deepest = await putLayerManifest(root, "past-the-depth-bound");
  const deeper = await putIndex(root, [
    {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: deepest.digest,
      size: Buffer.byteLength(deepest.json),
    },
  ]);
  const subject = await putIndex(root, [], {
    mediaType: "application/vnd.oci.image.index.v1+json",
    digest: deeper.digest,
    size: Buffer.byteLength(deeper.json),
  });
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as Record<
    string,
    unknown
  >;
  index.subject = {
    mediaType: "application/vnd.oci.image.index.v1+json",
    digest: subject.digest,
    size: Buffer.byteLength(subject.json),
  };
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  const report = await inspectLayout(root, { max_index_depth: 1 });
  expect(report.findings).toEqual([
    expect.objectContaining({
      kind: "nested_index_depth_exceeded",
      digest: deeper.digest,
    }),
  ]);
  expect(report.indexes.map((entry) => entry.depth)).toEqual([0, 1]);
  expect(
    report.blobs.find((entry) => entry.digest === deepest.layer)?.referenced,
  ).toBeNull();
  expect(report.coverage.status).toBe("partial");
});

it("reports a present subject with an unknown media type", async () => {
  const root = await createTestTempDirectory("rea-oci-unknown-subject-");
  await writeOciImageLayoutFixture(root);
  const subject = await putOciBlob(root, "opaque-subject");
  // The opaque subject is not walked, so a blob it may name stays unknown.
  const child = await putOciBlob(root, "opaque-subject-child");
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as Record<
    string,
    unknown
  >;
  index.subject = {
    mediaType: "application/vnd.example.unknown",
    digest: subject,
    size: 14,
  };
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  const report = await inspectLayout(root);
  expect(report.findings).toEqual([
    expect.objectContaining({
      kind: "unknown_media_type",
      digest: subject,
    }),
  ]);
  expect(
    report.blobs.find((entry) => entry.digest === subject)?.referenced,
  ).toBe(true);
  expect(
    report.blobs.find((entry) => entry.digest === child)?.referenced,
  ).toBeNull();
  expect(report.coverage.status).not.toBe("complete");
});

it("keeps blobs unknown under a present subject with an unsupported digest", async () => {
  const root = await createTestTempDirectory("rea-oci-sha1-subject-");
  await writeOciImageLayoutFixture(root);
  const hex = "b".repeat(40);
  const subjectJson = JSON.stringify({ schemaVersion: 2, layers: [] });
  await mkdir(join(root, "blobs", "sha1"), { recursive: true });
  await writeFile(join(root, "blobs", "sha1", hex), subjectJson);
  const child = await putOciBlob(root, "sha1-subject-child");
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as Record<
    string,
    unknown
  >;
  index.subject = {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: `sha1:${hex}`,
    size: Buffer.byteLength(subjectJson),
  };
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  const report = await inspectLayout(root);
  expect(
    report.findings.some((finding) => finding.kind === "unreferenced_blob"),
  ).toBe(false);
  expect(
    report.blobs.find((entry) => entry.digest === child)?.referenced,
  ).toBeNull();
  expect(report.coverage.status).not.toBe("complete");
});

it("does not report a subject that is absent from the layout", async () => {
  const root = await createTestTempDirectory("rea-oci-absent-subject-");
  await writeOciImageLayoutFixture(root);
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as Record<
    string,
    unknown
  >;
  index.subject = {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: `sha256:${"a".repeat(64)}`,
    size: 10,
  };
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  const report = await inspectLayout(root);
  expect(report.findings).toEqual([]);
  expect(report.coverage.status).toBe("complete");
});

it("reports a subject it cannot model and keeps blobs unknown", async () => {
  const root = await createTestTempDirectory("rea-oci-malformed-subject-");
  await writeOciImageLayoutFixture(root);
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as Record<
    string,
    unknown
  >;
  index.subject = "not-a-descriptor";
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  const report = await inspectLayout(root);
  expect(report.findings).toEqual([
    expect.objectContaining({
      kind: "malformed_blob_json",
      message: expect.stringContaining("subject is not a JSON object"),
    }),
  ]);
  expect(report.coverage.status).not.toBe("complete");
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

it("walks a manifest listed after a path-shaped spelling of its digest", async () => {
  const root = await createTestTempDirectory("rea-oci-path-spelling-");
  const written = await writeOciImageLayoutFixture(root);
  const parsed = parseOciDigest(written.manifestDigest);
  if (parsed === undefined) throw new Error("expected sha256 digest");
  const manifest = {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: written.manifestDigest,
    size: written.manifestSize,
  };
  await writeFile(
    join(root, "index.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        { ...manifest, digest: `blobs/sha256/${parsed.hex}` },
        manifest,
      ],
    })}\n`,
  );
  const report = await inspectLayout(root);
  expect(report.images.map((image) => image.digest)).toEqual([
    written.manifestDigest,
  ]);
  expect(report.images[0]?.layers).toHaveLength(1);
});

it("hashes a blob named by several hex-casing spellings once", async () => {
  const root = await createTestTempDirectory("rea-oci-alias-hash-");
  const written = await writeOciImageLayoutFixture(root);
  const baseline = await inspectLayout(root);
  const parsed = parseOciDigest(written.layerDigest);
  if (parsed === undefined) throw new Error("expected sha256 digest");
  const spellings = [
    `sha256:${parsed.hex.toUpperCase()}`,
    `sha256:${parsed.hex.slice(0, 32).toUpperCase()}${parsed.hex.slice(32)}`,
  ];
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    manifests: Record<string, unknown>[];
  };
  for (const digest of spellings)
    index.manifests.push({
      mediaType: "application/vnd.oci.image.layer.v1.tar",
      digest,
      size: 11,
    });
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  const report = await inspectLayout(root);
  expect(report.coverage.blobs_hashed).toBe(baseline.coverage.blobs_hashed);
  const layerRow = report.blobs.find(
    (blob) => blob.digest === written.layerDigest,
  );
  for (const digest of spellings)
    expect(report.blobs.find((blob) => blob.digest === digest)).toMatchObject({
      hashed: true,
      sha256: layerRow?.sha256,
    });
});

it("walks an index and manifest named by hex-casing aliases once", async () => {
  const root = await createTestTempDirectory("rea-oci-alias-walk-");
  const written = await writeOciImageLayoutFixture(root);
  const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
  const manifest = {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: written.manifestDigest,
    size: written.manifestSize,
  };
  const upper = (digest: string) => {
    const parsed = parseOciDigest(digest);
    if (parsed === undefined) throw new Error("expected sha256 digest");
    return `${parsed.algorithm}:${parsed.hex.toUpperCase()}`;
  };
  const nestedJson = `${JSON.stringify({
    schemaVersion: 2,
    mediaType: OCI_INDEX,
    manifests: [manifest, { ...manifest, digest: upper(manifest.digest) }],
  })}\n`;
  const nested = {
    mediaType: OCI_INDEX,
    digest: await putOciBlob(root, nestedJson),
    size: Buffer.byteLength(nestedJson),
  };
  await writeFile(
    join(root, "index.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_INDEX,
      manifests: [nested, { ...nested, digest: upper(nested.digest) }],
    })}\n`,
  );
  const report = await inspectLayout(root);
  expect(report.indexes.map((entry) => entry.depth)).toEqual([0, 1]);
  expect(report.images).toHaveLength(1);
  expect(report.indexes[0]?.entries.map((entry) => entry.digest)).toEqual([
    nested.digest,
    upper(nested.digest),
  ]);
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

const writeSha1LayerLayout = async (root: string, declaredSize: number) => {
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
  const digest = `sha1:${hex}`;
  manifest.layers.push({
    mediaType: "application/vnd.oci.image.layer.v1.tar",
    digest,
    size: declaredSize,
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
  return { hex, digest };
};

it("reports an unsupported layer digest without claiming the blob is missing", async () => {
  const root = await createTestTempDirectory("rea-oci-sha1-layer-");
  const { hex, digest } = await writeSha1LayerLayout(root, 5);
  const report = await inspectLayout(root);
  expect(report.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "unsupported_digest_algorithm",
        digest,
      }),
    ]),
  );
  expect(
    report.findings.some(
      (finding) =>
        finding.digest === digest &&
        (finding.kind === "missing_blob" ||
          finding.kind === "unreferenced_blob"),
    ),
  ).toBe(false);
  expect(report.blobs.find((blob) => blob.digest === digest)).toMatchObject({
    path: `blobs/sha1/${hex}`,
    kind: "file",
    present: true,
    hashed: false,
    observed_size: 5,
  });
  expect(
    report.images[0]?.layers.find((layer) => layer.digest === digest),
  ).toMatchObject({ present: true });
  expect(report.coverage.status).toBe("partial");
});

it("checks declared sizes and records observed_size for unsupported-digest blobs", async () => {
  const mismatchRoot = await createTestTempDirectory(
    "rea-oci-sha1-size-mismatch-",
  );
  const { hex, digest } = await writeSha1LayerLayout(mismatchRoot, 6);
  const mismatchReport = await inspectLayout(mismatchRoot);
  expect(mismatchReport.findings).toEqual([
    {
      kind: "unsupported_digest_algorithm",
      digest,
      path: null,
      message: `Digest ${digest} uses an unsupported algorithm.`,
    },
    {
      kind: "size_mismatch",
      digest,
      path: `blobs/sha1/${hex}`,
      message: `Blob ${digest} declared size 6 disagrees with file size 5.`,
    },
  ]);
  expect(
    mismatchReport.blobs.find((blob) => blob.digest === digest),
  ).toMatchObject({
    path: `blobs/sha1/${hex}`,
    declared_size: 6,
    observed_size: 5,
    present: true,
    hashed: false,
    sha256: null,
    sha512: null,
    referenced: true,
    kind: "file",
  });
  expect(mismatchReport.coverage.blobs_hashed).toBe(3);

  const matchingRoot = await createTestTempDirectory(
    "rea-oci-sha1-size-match-",
  );
  await writeSha1LayerLayout(matchingRoot, 5);
  const matchingReport = await inspectLayout(matchingRoot);
  expect(matchingReport.findings).toEqual([
    {
      kind: "unsupported_digest_algorithm",
      digest,
      path: null,
      message: `Digest ${digest} uses an unsupported algorithm.`,
    },
  ]);
  expect(
    matchingReport.findings.some((finding) => finding.kind === "size_mismatch"),
  ).toBe(false);
  expect(
    matchingReport.blobs.find((blob) => blob.digest === digest),
  ).toMatchObject({
    declared_size: 5,
    observed_size: 5,
    present: true,
    hashed: false,
    kind: "file",
  });
});

it("reports missing and symlinked unsupported-digest blobs as presence defects", async () => {
  const missingRoot = await createTestTempDirectory("rea-oci-sha1-missing-");
  const missing = await writeSha1LayerLayout(missingRoot, 5);
  await unlink(join(missingRoot, "blobs", "sha1", missing.hex));
  const missingReport = await inspectLayout(missingRoot);
  expect(missingReport.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "unsupported_digest_algorithm",
        digest: missing.digest,
      }),
      expect.objectContaining({
        kind: "missing_blob",
        digest: missing.digest,
        path: `blobs/sha1/${missing.hex}`,
      }),
    ]),
  );
  expect(
    missingReport.blobs.find((blob) => blob.digest === missing.digest),
  ).toMatchObject({ kind: "missing", present: false });

  const linkRoot = await createTestTempDirectory("rea-oci-sha1-symlink-");
  const linked = await writeSha1LayerLayout(linkRoot, 5);
  const blobPath = join(linkRoot, "blobs", "sha1", linked.hex);
  await unlink(blobPath);
  await writeFile(join(linkRoot, "outside"), "layer");
  await symlink(join(linkRoot, "outside"), blobPath);
  const linkReport = await inspectLayout(linkRoot);
  expect(linkReport.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "unsupported_digest_algorithm",
        digest: linked.digest,
      }),
      expect.objectContaining({
        kind: "symlink_blob",
        digest: linked.digest,
        path: `blobs/sha1/${linked.hex}`,
      }),
    ]),
  );
  expect(
    linkReport.findings.some(
      (finding) =>
        finding.digest === linked.digest && finding.kind === "missing_blob",
    ),
  ).toBe(false);
  expect(
    linkReport.blobs.find((blob) => blob.digest === linked.digest),
  ).toMatchObject({ kind: "symlink", present: false });
});

it("keeps a referenced blob under a symlinked sha1 directory unexamined, not missing", async () => {
  const root = await createTestTempDirectory("rea-oci-sha1-dir-symlink-");
  const { hex, digest } = await writeSha1LayerLayout(root, 5);
  const linkPath = join(root, "blobs", "sha1");
  await rename(linkPath, join(root, "elsewhere"));
  await symlink(join(root, "elsewhere"), linkPath);
  const report = await inspectLayout(root);
  expect(report.findings).toContainEqual({
    kind: "symlink_blob",
    digest,
    path: `blobs/sha1/${hex}`,
    message: `Blob ${digest} is under symlinked directory blobs/sha1, which was not followed.`,
  });
  expect(
    report.findings.some(
      (finding) => finding.digest === digest && finding.kind === "missing_blob",
    ),
  ).toBe(false);
  expect(report.blobs.find((blob) => blob.digest === digest)).toMatchObject({
    kind: "symlink",
    present: false,
  });
  expect(report.coverage.status).toBe("partial");
});

it("keeps referenced sha256 blobs under a symlinked blob directory unexamined, not missing", async () => {
  const root = await createTestTempDirectory("rea-oci-sha256-dir-symlink-");
  const written = await writeOciImageLayoutFixture(root);
  const linkPath = join(root, "blobs", "sha256");
  await rename(linkPath, join(root, "elsewhere"));
  await symlink(join(root, "elsewhere"), linkPath);
  const report = await inspectLayout(root);
  expect(
    report.findings.some((finding) => finding.kind === "missing_blob"),
  ).toBe(false);
  expect(report.findings).toContainEqual(
    expect.objectContaining({
      kind: "symlink_blob",
      digest: written.manifestDigest,
      path: `blobs/sha256/${written.manifestDigest.slice("sha256:".length)}`,
    }),
  );
  expect(
    report.blobs.find((blob) => blob.digest === written.manifestDigest),
  ).toMatchObject({ kind: "symlink", present: false });
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

it.each([
  ["a missing directory", (root: string) => join(root, "missing")],
  [
    "a path under a regular file",
    (root: string) => join(root, "not-a-layout", "child"),
  ],
])("projects %s as an invalid path", async (_name, select) => {
  const root = await createTestTempDirectory("rea-oci-missing-");
  await writeFile(join(root, "not-a-layout"), "not a directory");
  const provider = new OciImageLayoutProvider();
  try {
    const result = await provider.inspect(
      inspectOciImageLayoutInputSchema.parse({ path: select(root) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatchObject({
        _tag: "AnalysisInputError",
        issues: [expect.objectContaining({ path: ["path"] })],
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

it("keeps malformed index.json as the primary when its handle close fails", async () => {
  const root = await createTestTempDirectory("rea-oci-handle-close-");
  await writeOciImageLayoutFixture(root);
  await writeFile(join(root, "index.json"), "{not json");
  const nativeClose = OwnedFileHandle.prototype.close;
  // Fault only the handle opened on index.json, selected by file identity.
  const index = await stat(join(root, "index.json"));
  const faulted: string[] = [];
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(function (this: OwnedFileHandle) {
      const opened = fstatSync(this.handle.fd);
      if (opened.dev === index.dev && opened.ino === index.ino) {
        faulted.push("index.json");
        return Promise.reject(new Error("controlled handle close failure"));
      }
      return nativeClose.call(this);
    });
  const provider = new OciImageLayoutProvider();
  try {
    const result = await provider.inspect(
      inspectOciImageLayoutInputSchema.parse({ path: root }),
    );
    expect(faulted.length).toBeGreaterThanOrEqual(1);
    expect(new Set(faulted)).toEqual(new Set(["index.json"]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The reader's close retries the handle, so only the primary is checked.
    const primary = primaryAnalysisError(result.error);
    expect(primary).toMatchObject({ _tag: "AnalysisInputError" });
    // The completed oci-layout hash survives the index.json close failure.
    expect(primary.partialObservation).toMatchObject({
      kind: "file-snapshot-hash",
      path: "oci-layout",
    });
    expect(JSON.stringify(primary)).toContain("is not valid JSON");
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

it.each([
  ["invalid UTF-8", Buffer.from([0x7b, 0xff, 0x7d]), "is not valid UTF-8"],
  ["invalid JSON", Buffer.from("{not json"), "is not valid JSON"],
  [
    "a duplicate member",
    Buffer.from('{"imageLayoutVersion":"1.0.0","imageLayoutVersion":"1.0.0"}'),
    "repeats object member",
  ],
])(
  "keeps the oci-layout snapshot when oci-layout holds %s",
  async (_case, content, message) => {
    const root = await createTestTempDirectory("rea-oci-malformed-layout-");
    await writeOciImageLayoutFixture(root);
    await writeFile(join(root, "oci-layout"), content);
    const provider = new OciImageLayoutProvider();
    try {
      const result = await provider.inspect(
        inspectOciImageLayoutInputSchema.parse({ path: root }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const primary = primaryAnalysisError(result.error);
      expect(JSON.stringify(primary)).toContain(message);
      expect(primary.partialObservation).toMatchObject({
        kind: "file-snapshot-hash",
        path: "oci-layout",
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: content.length,
      });
    } finally {
      await provider.close();
    }
  },
);

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

it("counts entries the directory reader examined but omitted", async () => {
  const root = await createTestTempDirectory("rea-oci-examined-entries-");
  await writeOciImageLayoutFixture(root);
  let yielded = 0;
  class SkippingReader extends DirectoryArtifactReader {
    override async *entries(
      ...args: Parameters<DirectoryArtifactReader["entries"]>
    ): ReturnType<DirectoryArtifactReader["entries"]> {
      const [signal, selection] = args;
      const options =
        typeof selection === "function"
          ? { descendInto: selection }
          : selection;
      for await (const entry of super.entries(signal, {
        ...options,
        onCoverage: () => undefined,
      })) {
        yielded += 1;
        yield entry;
      }
      options?.onCoverage?.({
        status: "unknown",
        limitations: ["Skipped 1 entry name that is not valid UTF-8."],
        examinedEntries: yielded + 1,
      });
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
    expect(report.coverage.entries_examined).toBe(yielded + 1);
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
    // The oci-layout observation completed before the failed read.
    expect(failure.partialObservation).toMatchObject({
      kind: "file-snapshot-hash",
      path: "oci-layout",
    });
  } finally {
    inspectFile.mockRestore();
  }
});

it.each([
  {
    name: "its descriptor close fails",
    finalize: (path: string, value: unknown) =>
      new ArtifactFileCleanupFailure(
        new RegularFileCleanupFailure({
          path,
          owner: { close: async () => undefined } as never,
          outcome: { kind: "completed", value },
          cleanupCause: new Error("controlled close failure"),
        }),
        new AnalysisCleanupLease(async () => undefined, [path]),
      ),
  },
  {
    name: "cancellation arrives during its close",
    finalize: (_path: string, value: unknown) =>
      new ArtifactFileCancelled({
        reason: new Error("controlled cancellation"),
        outcome: { kind: "completed", value },
      }),
  },
])(
  "keeps the completed oci-layout snapshot when $name",
  async ({ finalize }) => {
    const root = await createTestTempDirectory("rea-oci-layout-finalize-");
    await writeOciImageLayoutFixture(root);
    const layoutBytes = await readFile(join(root, "oci-layout"));
    let failure: ArtifactReaderFailure | undefined;
    class FinalizingReader extends DirectoryArtifactReader {
      override async inspectFile<Value>(
        entry: Parameters<DirectoryArtifactReader["inspectFile"]>[0],
        inspect: (file: FileHandle) => Promise<Value>,
        signal?: AbortSignal,
      ): Promise<Value> {
        const value = await super.inspectFile(entry, inspect, signal);
        if (entry.path !== "oci-layout") return value;
        failure = finalize(entry.adapterKey, value);
        throw failure;
      }
    }
    const reader = new FinalizingReader(root);
    try {
      await expect(
        parseOciImageLayout(
          reader,
          inspectOciImageLayoutInputSchema.parse({ path: root }),
        ),
      ).rejects.toSatisfy((cause: unknown) => {
        expect(cause).toBe(failure);
        expect(failure?.partialObservation).toEqual({
          kind: "file-snapshot-hash",
          path: "oci-layout",
          sha256: createHash("sha256").update(layoutBytes).digest("hex"),
          bytes: layoutBytes.length,
        });
        return true;
      });
    } finally {
      await reader.close();
    }
  },
);

it("preserves a reader integrity failure that wraps a blob JSON parse failure", async () => {
  const root = await createTestTempDirectory("rea-oci-blob-integrity-");
  await writeOciImageLayoutFixture(root);
  const brokenJson = "{not-json\n";
  const manifestDigest = await putOciBlob(root, brokenJson);
  const parsed = parseOciDigest(manifestDigest);
  if (parsed === undefined) throw new Error("expected sha256 manifest digest");
  const manifestEntryPath = `blobs/${parsed.algorithm}/${parsed.hex}`;
  const manifestDiskPath = join(root, "blobs", parsed.algorithm, parsed.hex);
  await writeFile(
    join(root, "index.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: manifestDigest,
          size: Buffer.byteLength(brokenJson),
        },
      ],
    })}\n`,
  );

  // Control: an unmutated malformed JSON blob is reported as a finding.
  const plainReport = await inspectLayout(root);
  expect(plainReport.findings).toContainEqual(
    expect.objectContaining({
      kind: "malformed_blob_json",
      digest: manifestDigest,
    }),
  );

  class MutatingOnReadReader extends DirectoryArtifactReader {
    override inspectFile<Value>(
      entry: Parameters<DirectoryArtifactReader["inspectFile"]>[0],
      inspect: (file: FileHandle) => Promise<Value>,
      signal?: AbortSignal,
    ): Promise<Value> {
      return super.inspectFile(
        entry,
        async (file) => {
          try {
            return await inspect(file);
          } finally {
            if (entry.path === manifestEntryPath)
              await writeFile(manifestDiskPath, "{mutated-malformed-json\n");
          }
        },
        signal,
      );
    }
  }

  const reader = new MutatingOnReadReader(root);
  try {
    await expect(
      parseOciImageLayout(
        reader,
        inspectOciImageLayoutInputSchema.parse({ path: root }),
      ),
    ).rejects.toSatisfy((cause: unknown) => {
      expect(cause).toBeInstanceOf(ArtifactReaderFailure);
      if (!(cause instanceof ArtifactReaderFailure)) return false;
      expect(cause.reason).toBe("integrity");
      expect(cause.integrityCheck).toBe("member-identity");
      expect(cause.cause).toBeInstanceOf(ParseFailureError);
      expect(cause.partialObservation).toMatchObject({
        kind: "file-snapshot-hash",
        path: "oci-layout",
      });
      return true;
    });
  } finally {
    await reader.close();
  }
});

it("keeps the oci-layout snapshot when hashing a referenced blob fails", async () => {
  const root = await createTestTempDirectory("rea-oci-blob-open-");
  const written = await writeOciImageLayoutFixture(root);
  const layerHex = written.layerDigest.slice("sha256:".length);
  const nativeOpen = DirectoryArtifactReader.prototype.open;
  const open = vi
    .spyOn(DirectoryArtifactReader.prototype, "open")
    .mockImplementation(async function (
      this: DirectoryArtifactReader,
      ...args: Parameters<DirectoryArtifactReader["open"]>
    ) {
      if (args[0].path.endsWith(layerHex))
        throw new ArtifactReaderFailure("io", "controlled open failure");
      return nativeOpen.apply(this, args);
    });
  const provider = new OciImageLayoutProvider();
  try {
    const result = await provider.inspect(
      inspectOciImageLayoutInputSchema.parse({ path: root }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const primary = primaryAnalysisError(result.error);
    expect(primary.partialObservation).toMatchObject({
      kind: "file-snapshot-hash",
      path: "oci-layout",
    });
  } finally {
    open.mockRestore();
    await provider.close();
  }
});

const writeSharedLayerLayout = async (
  root: string,
  manifestCount: number,
  layerCount: number,
  config = `${JSON.stringify({
    architecture: "amd64",
    os: "linux",
    rootfs: { type: "layers", diff_ids: [] },
  })}\n`,
): Promise<void> => {
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

it("counts a malformed config in json_bytes_read", async () => {
  const root = await createTestTempDirectory("rea-oci-malformed-config-bytes-");
  const written = await writeOciImageLayoutFixture(root);
  const blobPath = (digest: string): string => {
    const parsed = parseOciDigest(digest);
    if (parsed === undefined) throw new Error(`bad digest ${digest}`);
    return join(root, "blobs", parsed.algorithm, parsed.hex);
  };
  const malformed = Buffer.from(`{"architecture": "amd64",${" ".repeat(4096)}`);
  await writeFile(blobPath(written.configDigest), malformed);
  const expected =
    (await readFile(join(root, "oci-layout"))).length +
    (await readFile(join(root, "index.json"))).length +
    (await readFile(blobPath(written.manifestDigest))).length +
    malformed.length;
  const report = await inspectLayout(root);
  expect(report.findings).toContainEqual(
    expect.objectContaining({
      kind: "malformed_blob_json",
      digest: written.configDigest,
    }),
  );
  expect(report.coverage.json_bytes_read).toBe(expected);
});

it("refuses index entry text that accumulates past max_descriptor_bytes", async () => {
  const root = await createTestTempDirectory("rea-oci-descriptor-bytes-");
  const written = await writeOciImageLayoutFixture(root);
  const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
  const entry = {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: written.manifestDigest,
    size: written.manifestSize,
    annotations: { note: "x".repeat(200) },
  };
  const nested = [];
  for (let index = 0; index < 3; index += 1) {
    const body = `${JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_INDEX,
      manifests: [
        {
          ...entry,
          annotations: { note: `${String(index)}${"x".repeat(200)}` },
        },
      ],
    })}\n`;
    nested.push({
      mediaType: OCI_INDEX,
      digest: await putOciBlob(root, body),
      size: Buffer.byteLength(body),
    });
  }
  await writeFile(
    join(root, "index.json"),
    `${JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: nested })}\n`,
  );
  const reader = new DirectoryArtifactReader(root);
  try {
    await expect(
      parseOciImageLayout(
        reader,
        inspectOciImageLayoutInputSchema.parse({
          path: root,
          max_descriptor_bytes: 1024,
        }),
      ),
    ).rejects.toSatisfy((cause: unknown) => {
      expect(cause).toBeInstanceOf(ParseFailureError);
      if (!(cause instanceof ParseFailureError)) return false;
      expect(cause.failure).toMatchObject({
        kind: "limit",
        detail:
          "OCI image layout retained descriptor text exceeds the 1024-byte budget.",
        limit: { name: "max_descriptor_bytes", maximum: 1024 },
      });
      return true;
    });
  } finally {
    await reader.close();
  }
  const report = await inspectLayout(root);
  expect(report.indexes).toHaveLength(4);
});

it("refuses accepted layer and config text that accumulates past max_descriptor_bytes", async () => {
  const root = await createTestTempDirectory(
    "rea-oci-accepted-descriptor-bytes-",
  );
  await writeOciImageLayoutFixture(root);
  const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
  const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
  const OCI_LAYER = "application/vnd.oci.image.layer.v1.tar";
  const expectDescriptorBytesLimit = async () => {
    const reader = new DirectoryArtifactReader(root);
    try {
      await expect(
        parseOciImageLayout(
          reader,
          inspectOciImageLayoutInputSchema.parse({
            path: root,
            max_descriptor_bytes: 1024,
          }),
        ),
      ).rejects.toSatisfy((cause: unknown) => {
        expect(cause).toBeInstanceOf(ParseFailureError);
        if (!(cause instanceof ParseFailureError)) return false;
        expect(cause.failure).toMatchObject({
          kind: "limit",
          detail:
            "OCI image layout retained descriptor text exceeds the 1024-byte budget.",
          limit: { name: "max_descriptor_bytes", maximum: 1024 },
        });
        return true;
      });
    } finally {
      await reader.close();
    }
  };
  const writeManifests = async (bodies: string[]) => {
    const manifests = [];
    for (const body of bodies)
      manifests.push({
        mediaType: OCI_MANIFEST,
        digest: await putOciBlob(root, body),
        size: Buffer.byteLength(body),
      });
    await writeFile(
      join(root, "index.json"),
      `${JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests })}\n`,
    );
  };
  const emptyConfig = await putOciBlob(root, "{}");

  // Accepted layer descriptors with long, distinct digests across manifests
  // keep their text in image rows and findings, so they spend the budget.
  const layerManifests = [];
  for (let index = 0; index < 3; index += 1)
    layerManifests.push(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_MANIFEST,
        config: { ...OCI_EMPTY_CONFIG, digest: emptyConfig },
        layers: [
          {
            mediaType: OCI_LAYER,
            digest: `sha256:${String(index)}-${"l".repeat(400)}`,
            size: 1,
          },
        ],
      }),
    );
  await writeManifests(layerManifests);
  await expectDescriptorBytesLimit();

  // An accepted config descriptor with a long digest spends it too.
  await writeManifests([
    JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: {
        mediaType: "application/octet-stream",
        digest: `sha256:${"c".repeat(1100)}`,
        size: 2,
      },
      layers: [],
    }),
  ]);
  await expectDescriptorBytesLimit();
});

it("refuses rejected descriptor text that accumulates past max_descriptor_bytes", async () => {
  const root = await createTestTempDirectory(
    "rea-oci-rejected-descriptor-bytes-",
  );
  const written = await writeOciImageLayoutFixture(root);
  const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
  const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
  const expectDescriptorBytesLimit = async () => {
    const reader = new DirectoryArtifactReader(root);
    try {
      await expect(
        parseOciImageLayout(
          reader,
          inspectOciImageLayoutInputSchema.parse({
            path: root,
            max_descriptor_bytes: 1024,
          }),
        ),
      ).rejects.toSatisfy((cause: unknown) => {
        expect(cause).toBeInstanceOf(ParseFailureError);
        if (!(cause instanceof ParseFailureError)) return false;
        expect(cause.failure).toMatchObject({
          kind: "limit",
          detail:
            "OCI image layout retained descriptor text exceeds the 1024-byte budget.",
          limit: { name: "max_descriptor_bytes", maximum: 1024 },
        });
        return true;
      });
    } finally {
      await reader.close();
    }
  };

  // Rejected manifests[] entries (digest present, mediaType missing) across
  // entries and nested indexes accumulate past max_descriptor_bytes.
  const nested = [];
  for (let index = 0; index < 3; index += 1) {
    const body = `${JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_INDEX,
      manifests: [
        { digest: `sha256:${String(index)}-a-${"f".repeat(150)}`, size: 1 },
        { digest: `sha256:${String(index)}-b-${"f".repeat(150)}`, size: 1 },
      ],
    })}\n`;
    nested.push({
      mediaType: OCI_INDEX,
      digest: await putOciBlob(root, body),
      size: Buffer.byteLength(body),
    });
  }
  await writeFile(
    join(root, "index.json"),
    `${JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests: nested })}\n`,
  );
  await expectDescriptorBytesLimit();

  // Rejected subject, manifest config, and manifest layers[] descriptors with
  // large digests also spend max_descriptor_bytes.
  await writeFile(
    join(root, "index.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_INDEX,
      manifests: [],
      subject: { digest: `sha256:${"s".repeat(1024)}`, size: 1 },
    })}\n`,
  );
  await expectDescriptorBytesLimit();

  const emptyConfig = await putOciBlob(root, "{}");
  for (const manifestBody of [
    JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: { digest: `sha256:${"c".repeat(1024)}`, size: 2 },
      layers: [],
    }),
    JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_MANIFEST,
      config: { ...OCI_EMPTY_CONFIG, digest: emptyConfig },
      layers: [{ digest: `sha256:${"l".repeat(1024)}`, size: 1 }],
    }),
  ]) {
    const manifestDigest = await putOciBlob(root, manifestBody);
    await writeFile(
      join(root, "index.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        mediaType: OCI_INDEX,
        manifests: [
          {
            mediaType: OCI_MANIFEST,
            digest: manifestDigest,
            size: Buffer.byteLength(manifestBody),
          },
        ],
      })}\n`,
    );
    await expectDescriptorBytesLimit();
  }

  // A small rejected entry within max_descriptor_bytes still yields the
  // malformed_blob_json finding.
  await writeFile(
    join(root, "index.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      mediaType: OCI_INDEX,
      manifests: [
        {
          mediaType: OCI_MANIFEST,
          digest: written.manifestDigest,
          size: written.manifestSize,
        },
        { digest: "sha256:small", size: 1 },
      ],
    })}\n`,
  );
  const report = await inspectLayout(root, { max_descriptor_bytes: 1024 });
  expect(report.findings).toContainEqual(
    expect.objectContaining({
      kind: "malformed_blob_json",
      message: expect.stringContaining(
        "manifests[1] lacks a string mediaType (digest sha256:small)",
      ),
    }),
  );
  expect(report.indexes[0]?.entries).toHaveLength(1);
});

/** Serialized bytes of the config facts one image carries in the report. */
const configFactBytes = (image: Record<string, unknown>): number => {
  const {
    digest: _digest,
    media_type: _mediaType,
    config_digest: _configDigest,
    layers: _layers,
    ...facts
  } = image;
  return jsonByteLength(facts);
};

it("refuses a layout whose shared config expands past max_config_bytes", async () => {
  const root = await createTestTempDirectory("rea-oci-config-bytes-");
  await writeSharedLayerLayout(root, 5, 1);
  const reader = new DirectoryArtifactReader(root);
  let configBytes: number;
  try {
    const report = await parseOciImageLayout(
      reader,
      inspectOciImageLayoutInputSchema.parse({ path: root }),
    );
    const image = report.images[0];
    if (image === undefined) throw new Error("expected an image");
    configBytes = configFactBytes(image);
  } finally {
    await reader.close();
  }
  const maximum = configBytes * 2;
  await expectConfigBudgetRefusal(root, maximum, configBytes * 3);
});

it("charges expanded history records rather than config source bytes", async () => {
  const root = await createTestTempDirectory("rea-oci-config-history-");
  const config = `${JSON.stringify({
    architecture: "amd64",
    os: "linux",
    rootfs: { type: "layers", diff_ids: [] },
    history: Array.from({ length: 256 }, () => ({})),
  })}\n`;
  await writeSharedLayerLayout(root, 1, 1, config);
  const sourceBytes = Buffer.byteLength(config);
  // Each `{}` becomes a record with four null fields, so the facts are many
  // times the source. A budget that covers the source must still refuse.
  const maximum = sourceBytes * 4;
  const reader = new DirectoryArtifactReader(root);
  let factBytes: number;
  try {
    const report = await parseOciImageLayout(
      reader,
      inspectOciImageLayoutInputSchema.parse({ path: root }),
    );
    const image = report.images[0];
    if (image === undefined) throw new Error("expected an image");
    expect(image.history).toHaveLength(256);
    factBytes = configFactBytes(image);
  } finally {
    await reader.close();
  }
  expect(factBytes).toBeGreaterThan(maximum);
  await expectConfigBudgetRefusal(root, maximum, factBytes);
});

const expectConfigBudgetRefusal = async (
  root: string,
  maximum: number,
  required: number,
): Promise<void> => {
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
          required,
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
};

it("reports invalid rootfs.diff_ids members and keeps the other image facts", async () => {
  const root = await createTestTempDirectory("rea-oci-diff-ids-");
  const written = await writeOciImageLayoutFixture(root, {
    config: { diffIds: ["", "sha256:kept", 7 as unknown as string, ""] },
  });
  const report = await inspectLayout(root);
  expect(report.findings).toEqual([
    {
      kind: "malformed_blob_json",
      digest: written.configDigest,
      path: null,
      message: `Config ${written.configDigest} rootfs.diff_ids has 3 members that are not a nonempty string, first at [0]; they are omitted.`,
    },
  ]);
  expect(report.images[0]).toMatchObject({
    architecture: "amd64",
    rootfs_diff_ids: ["sha256:kept"],
    layers: [expect.objectContaining({ digest: written.layerDigest })],
  });
  expect(report.coverage.status).toBe("partial");
  const provider = new OciImageLayoutProvider();
  try {
    const result = await provider.inspect(
      inspectOciImageLayoutInputSchema.parse({ path: root }),
    );
    expect(result.ok).toBe(true);
  } finally {
    await provider.close();
  }
});

const writeLayoutWithConfigPatch = async (
  root: string,
  patch: (configDocument: Record<string, unknown>) => void,
) => {
  const written = await writeOciImageLayoutFixture(root);
  const blobPath = (digest: string) =>
    join(root, "blobs", "sha256", digest.slice("sha256:".length));
  const oldConfigPath = blobPath(written.configDigest);
  const configDocument = JSON.parse(
    await readFile(oldConfigPath, "utf8"),
  ) as Record<string, unknown>;
  patch(configDocument);
  const configJson = `${JSON.stringify(configDocument)}\n`;
  await unlink(oldConfigPath);
  const configDigest = await putOciBlob(root, configJson);
  const oldManifestPath = blobPath(written.manifestDigest);
  const manifest = JSON.parse(await readFile(oldManifestPath, "utf8")) as {
    config: Record<string, unknown>;
  };
  manifest.config = {
    ...manifest.config,
    digest: configDigest,
    size: Buffer.byteLength(configJson),
  };
  const manifestJson = `${JSON.stringify(manifest)}\n`;
  await unlink(oldManifestPath);
  const manifestDigest = await putOciBlob(root, manifestJson);
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    manifests: Record<string, unknown>[];
  };
  index.manifests[0] = {
    ...index.manifests[0],
    digest: manifestDigest,
    size: Buffer.byteLength(manifestJson),
  };
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  return { ...written, manifestDigest, configDigest };
};

it("reports a non-object config subobject and keeps the other image facts", async () => {
  const root = await createTestTempDirectory("rea-oci-config-subobject-");
  const written = await writeLayoutWithConfigPatch(root, (doc) => {
    doc.config = [];
  });
  const report = await inspectLayout(root);
  expect(report.findings).toEqual([
    {
      kind: "malformed_blob_json",
      digest: written.configDigest,
      path: null,
      message: `Config ${written.configDigest} config is not a JSON object; its runtime facts are not modeled.`,
    },
  ]);
  expect(report.images[0]).toMatchObject({
    architecture: "amd64",
    os: "linux",
    user: null,
    env: [],
    entrypoint: null,
    cmd: null,
    rootfs_diff_ids: [written.layerDigest],
    history: expect.arrayContaining([
      expect.objectContaining({ empty_layer: false }),
    ]),
    layers: [expect.objectContaining({ digest: written.layerDigest })],
  });
  expect(report.coverage.status).toBe("partial");
});

it("reports a non-object rootfs subobject and keeps the other image facts", async () => {
  const root = await createTestTempDirectory("rea-oci-rootfs-subobject-");
  const written = await writeLayoutWithConfigPatch(root, (doc) => {
    doc.rootfs = [];
  });
  const report = await inspectLayout(root);
  expect(report.findings).toEqual([
    {
      kind: "malformed_blob_json",
      digest: written.configDigest,
      path: null,
      message: `Config ${written.configDigest} rootfs is not a JSON object; its diff IDs are not modeled.`,
    },
  ]);
  expect(report.images[0]).toMatchObject({
    architecture: "amd64",
    os: "linux",
    user: "nobody",
    entrypoint: ["/bin/sh"],
    cmd: ["-c", "true"],
    rootfs_diff_ids: [],
    history: expect.arrayContaining([
      expect.objectContaining({ empty_layer: false }),
    ]),
    layers: [expect.objectContaining({ digest: written.layerDigest })],
  });
  expect(report.coverage.status).toBe("partial");
});

it("reports malformed config leaf fields and keeps the readable facts", async () => {
  const root = await createTestTempDirectory("rea-oci-config-leaves-");
  const written = await writeLayoutWithConfigPatch(root, (doc) => {
    const config = doc.config as Record<string, unknown>;
    doc.created = 7;
    config.Env = "A=1";
    config.Cmd = ["/bin/sh", false];
    config.WorkingDir = ["/srv"];
    config.Labels = { team: "core", build: 3 };
    config.ExposedPorts = ["80/tcp"];
  });
  const report = await inspectLayout(root);
  const at = `Config ${written.configDigest}`;
  expect(report.findings.map((finding) => finding.message)).toEqual([
    `${at} created is not a string; it is not modeled.`,
    `${at} config.Env is not an array; it is not modeled.`,
    `${at} config.Cmd is not an array of strings; it is not modeled.`,
    `${at} config.WorkingDir is not a string; it is not modeled.`,
    `${at} config.ExposedPorts is not a JSON object; it is not modeled.`,
    `${at} config.Labels has 1 value that is not a string; it is omitted.`,
  ]);
  expect(
    report.findings.every(
      (finding) =>
        finding.kind === "malformed_blob_json" &&
        finding.digest === written.configDigest,
    ),
  ).toBe(true);
  expect(report.images[0]).toMatchObject({
    architecture: "amd64",
    os: "linux",
    created: null,
    user: "nobody",
    env: [],
    entrypoint: ["/bin/sh"],
    cmd: null,
    working_dir: null,
    exposed_ports: [],
    labels: [{ name: "team", value: "core" }],
    rootfs_diff_ids: [written.layerDigest],
  });
  expect(report.coverage.status).toBe("partial");
});

it("reports Env members that name nothing and keeps the named ones", async () => {
  const root = await createTestTempDirectory("rea-oci-env-members-");
  const written = await writeLayoutWithConfigPatch(root, (doc) => {
    (doc.config as Record<string, unknown>).Env = ["A=1", 2, "=x", "B"];
  });
  const report = await inspectLayout(root);
  expect(report.findings.map((finding) => finding.message)).toEqual([
    `Config ${written.configDigest} config.Env has 2 members that are not a named string, first at [1]; they are omitted.`,
  ]);
  expect(report.images[0]?.env.map((binding) => binding.name)).toEqual([
    "A",
    "B",
  ]);
});

it("reports malformed history and keeps the readable records", async () => {
  const root = await createTestTempDirectory("rea-oci-history-members-");
  const written = await writeLayoutWithConfigPatch(root, (doc) => {
    doc.history = [false, { created_by: "RUN true", empty_layer: false }, 3];
  });
  const report = await inspectLayout(root);
  expect(report.findings).toEqual([
    {
      kind: "malformed_blob_json",
      digest: written.configDigest,
      path: null,
      message: `Config ${written.configDigest} history has 2 members that are not a JSON object, first at [0]; they are omitted.`,
    },
  ]);
  expect(report.images[0]).toMatchObject({
    architecture: "amd64",
    os: "linux",
    rootfs_diff_ids: [written.layerDigest],
    history: [expect.objectContaining({ created_by: "RUN true" })],
  });
  expect(report.coverage.status).toBe("partial");
});

it("reports malformed fields inside history records and keeps the readable fields", async () => {
  const root = await createTestTempDirectory("rea-oci-history-fields-");
  const written = await writeLayoutWithConfigPatch(root, (doc) => {
    doc.history = [{ created_by: 7, empty_layer: "false", comment: "kept" }];
  });
  const report = await inspectLayout(root);
  expect(report.findings).toEqual([
    {
      kind: "malformed_blob_json",
      digest: written.configDigest,
      path: null,
      message: `Config ${written.configDigest} history has 1 member whose created_by is not a string, first at [0]; it is not modeled.`,
    },
    {
      kind: "malformed_blob_json",
      digest: written.configDigest,
      path: null,
      message: `Config ${written.configDigest} history has 1 member whose empty_layer is not a boolean, first at [0]; it is not modeled.`,
    },
  ]);
  expect(report.images[0]?.history).toEqual([
    {
      created: null,
      created_by: null,
      empty_layer: null,
      comment: "kept",
    },
  ]);
  expect(report.coverage.status).toBe("partial");

  const nullRoot = await createTestTempDirectory(
    "rea-oci-history-null-fields-",
  );
  await writeLayoutWithConfigPatch(nullRoot, (doc) => {
    doc.history = [
      {
        created: null,
        created_by: null,
        empty_layer: null,
        comment: null,
      },
    ];
  });
  const nullReport = await inspectLayout(nullRoot);
  expect(nullReport.findings).toEqual([]);
  expect(nullReport.images[0]?.history).toEqual([
    {
      created: null,
      created_by: null,
      empty_layer: null,
      comment: null,
    },
  ]);
  expect(nullReport.coverage.status).toBe("complete");
});

it("reports a non-array history and keeps the other image facts", async () => {
  const root = await createTestTempDirectory("rea-oci-history-shape-");
  const written = await writeLayoutWithConfigPatch(root, (doc) => {
    doc.history = { created_by: "RUN true" };
  });
  const report = await inspectLayout(root);
  expect(report.findings.map((finding) => finding.message)).toEqual([
    `Config ${written.configDigest} history is not an array; it is not modeled.`,
  ]);
  expect(report.images[0]).toMatchObject({
    user: "nobody",
    rootfs_diff_ids: [written.layerDigest],
    history: [],
  });
  expect(report.coverage.status).toBe("partial");
});

it("treats null config leaf fields as omitted", async () => {
  const root = await createTestTempDirectory("rea-oci-null-leaves-");
  await writeLayoutWithConfigPatch(root, (doc) => {
    const config = doc.config as Record<string, unknown>;
    config.Env = null;
    config.Entrypoint = null;
    config.Cmd = null;
    config.Labels = null;
  });
  const report = await inspectLayout(root);
  expect(report.findings).toEqual([]);
  expect(report.images[0]).toMatchObject({
    env: [],
    entrypoint: null,
    cmd: null,
    labels: [],
  });
  expect(report.coverage.status).toBe("complete");
});

it("keeps absent config and rootfs subobjects defect-free while reporting null subobjects", async () => {
  const absentRoot = await createTestTempDirectory("rea-oci-absent-subobject-");
  await writeLayoutWithConfigPatch(absentRoot, (doc) => {
    delete doc.config;
    delete doc.rootfs;
  });
  const absentReport = await inspectLayout(absentRoot);
  expect(absentReport.findings).toEqual([]);
  expect(absentReport.images[0]).toMatchObject({
    architecture: "amd64",
    os: "linux",
    user: null,
    rootfs_diff_ids: [],
  });
  expect(absentReport.coverage.status).toBe("complete");

  const nullRoot = await createTestTempDirectory("rea-oci-null-subobject-");
  const nullWritten = await writeLayoutWithConfigPatch(nullRoot, (doc) => {
    doc.config = null;
    doc.rootfs = null;
  });
  const nullReport = await inspectLayout(nullRoot);
  expect(nullReport.findings.map((finding) => finding.message)).toEqual([
    `Config ${nullWritten.configDigest} config is not a JSON object; its runtime facts are not modeled.`,
    `Config ${nullWritten.configDigest} rootfs is not a JSON object; its diff IDs are not modeled.`,
  ]);
  expect(nullReport.coverage.status).toBe("partial");
});

it("omits empty ExposedPorts and Volumes keys with a finding", async () => {
  const root = await createTestTempDirectory("rea-oci-empty-keys-");
  const written = await writeOciImageLayoutFixture(root, {
    config: {
      exposedPorts: { "": {}, "80/tcp": {} },
      volumes: { "": {} },
    },
  });
  const report = await inspectLayout(root);
  expect(report.images[0]).toMatchObject({
    exposed_ports: ["80/tcp"],
    volumes: [],
  });
  expect(report.findings.map((finding) => finding.message)).toEqual([
    `Config ${written.configDigest} config.ExposedPorts has an empty key; it is omitted.`,
    `Config ${written.configDigest} config.Volumes has an empty key; it is omitted.`,
  ]);
});

it("reports empty annotation and label keys as written", async () => {
  const root = await createTestTempDirectory("rea-oci-empty-annotation-");
  await writeOciImageLayoutFixture(root, {
    config: { labels: { "": "label-value" } },
    extraIndexAnnotations: { "": "annotation-value" },
  });
  const report = await inspectLayout(root);
  expect(report.indexes[0]?.entries[0]?.annotations).toContainEqual({
    name: "",
    value: "annotation-value",
  });
  expect(report.images[0]?.labels).toEqual([
    { name: "", value: "label-value" },
  ]);
  expect(report.coverage.status).toBe("complete");
});

it("reports a manifest without a config as damaged", async () => {
  const root = await createTestTempDirectory("rea-oci-no-config-");
  const written = await writeOciImageLayoutFixture(root);
  const orphan = await putOciBlob(root, "unknown-reference-status");
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    layers: [],
  });
  const manifestDigest = await putOciBlob(root, manifest);
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    manifests: Record<string, unknown>[];
  };
  index.manifests.push({
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: manifestDigest,
    size: Buffer.byteLength(manifest),
  });
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  const report = await inspectLayout(root);
  expect(report.findings).toEqual([
    expect.objectContaining({
      kind: "malformed_blob_json",
      digest: manifestDigest,
      message: `Manifest ${manifestDigest} lacks a config descriptor; the config is not modeled.`,
    }),
  ]);
  expect(
    report.images.find((image) => image.digest === manifestDigest)
      ?.config_digest,
  ).toBeNull();
  expect(
    report.images.find((image) => image.digest === written.manifestDigest),
  ).toBeDefined();
  expect(
    report.blobs.find((entry) => entry.digest === orphan)?.referenced,
  ).toBeNull();
  expect(report.coverage.status).toBe("partial");
});

it("describes an unusable descriptor size without serializing it", async () => {
  const root = await createTestTempDirectory("rea-oci-size-value-");
  await writeOciImageLayoutFixture(root);
  const indexPath = join(root, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    manifests: Record<string, unknown>[];
  };
  const first = index.manifests[0];
  if (first === undefined) throw new Error("expected an index descriptor");
  const marker = "do-not-echo-".repeat(1000);
  index.manifests.push(
    { ...first, size: [marker, { nested: [marker] }] },
    { ...first, size: { value: marker } },
    { ...first, size: marker },
    { ...first, size: -1 },
  );
  await writeFile(indexPath, `${JSON.stringify(index)}\n`);
  const report = await inspectLayout(root);
  const messages = report.findings
    .filter((finding) => finding.kind === "malformed_blob_json")
    .map((finding) => finding.message);
  expect(messages).toEqual([
    expect.stringContaining("size (an array of 2 items) is not"),
    expect.stringContaining("size (an object) is not"),
    expect.stringContaining(
      `size (a ${String(marker.length)}-character string) is not`,
    ),
    expect.stringContaining("size -1 is not"),
  ]);
  for (const message of messages) {
    expect(message).not.toContain("do-not-echo");
    expect(message.length).toBeLessThan(300);
  }
});
