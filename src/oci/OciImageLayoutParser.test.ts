import { mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  inspectOciImageLayoutInputSchema,
  ociImageLayoutSchema,
  parseOciDigest,
} from "../domain/oci/imageLayout.js";
import { ParseFailureError } from "../domain/parseFailure.js";
import { DirectoryArtifactReader } from "../resources/index.js";
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
      mediaType: "application/vnd.oci.image.manifest.v1+json",
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
