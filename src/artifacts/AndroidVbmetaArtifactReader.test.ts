import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { expect, it } from "vitest";

import { sha256Hex } from "../kernel/sha256Hex.js";
import { ANDROID_VBMETA_LIMITATIONS } from "../domain/firmware/androidVbmeta.js";
import {
  SAMPLE_CHAIN_PARTITION,
  SAMPLE_PUBLIC_KEY,
  SAMPLE_PUBLIC_KEY_METADATA,
  androidVbmetaMalformedLaterDescriptor,
  androidVbmetaRefusals,
  sampleAndroidVbmeta,
} from "../domain/firmware/androidVbmeta.fixture.js";
import { classifyArtifactBytesAtPath } from "../../tests/fixtures/artifactClassification.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { AndroidVbmetaArtifactReader } from "./AndroidVbmetaArtifactReader.js";

const collect = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const writeCarrier = async (name: string, bytes: Buffer): Promise<string> => {
  const directory = await createTestTempDirectory("rea-android-vbmeta-");
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
};

it("classifies AVB0 by content and leaves an AVBf footer alone", () => {
  expect(
    classifyArtifactBytesAtPath("notes.txt", sampleAndroidVbmeta()),
  ).toEqual({ kind: "container", format: "android-vbmeta" });
  expect(classifyArtifactBytesAtPath("boot.img", Buffer.from("AVB0"))).toEqual({
    kind: "container",
    format: "android-vbmeta",
  });
  expect(classifyArtifactBytesAtPath("boot.img", Buffer.from("AVBf"))).toEqual({
    kind: "resource",
    format: "file",
  });
});

it("reports unknown coverage and retains tentative facts for an unsupported major version", async () => {
  const bytes = sampleAndroidVbmeta();
  bytes.writeUInt32BE(2, 4);
  const path = await writeCarrier("vbmeta.img", bytes);
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.coverage.status).toBe("unknown");
  const root = snapshot.occurrences.find((row) => row.logical_path === ".");
  expect(root?.format_metadata).toMatchObject({
    required_libavb_version_major: 2,
    descriptor_failure: null,
    descriptors: expect.arrayContaining([
      expect.objectContaining({ tag_name: "CHAIN_PARTITION" }),
    ]),
  });
  expect(snapshot.occurrences.map((row) => row.logical_path)).toContain(
    "public_key",
  );
});

it("reports unknown coverage for a chain partition with rollback index location 0", async () => {
  const bytes = sampleAndroidVbmeta();
  const chainLocation = bytes.indexOf(
    Buffer.from([0, 0, 0, 2, 0, 0, 0, SAMPLE_CHAIN_PARTITION.length]),
  );
  expect(chainLocation).toBeGreaterThan(0);
  bytes.writeUInt32BE(0, chainLocation);
  const path = await writeCarrier("vbmeta.img", bytes);
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.coverage.status).toBe("unknown");
  const root = snapshot.occurrences.find((row) => row.logical_path === ".");
  expect(root?.format_metadata).toMatchObject({
    descriptor_failure: {
      field: "rollback index location",
      offset: chainLocation,
    },
  });
  const descriptors =
    root?.format_metadata?.kind === "android-vbmeta"
      ? root.format_metadata.descriptors
      : [];
  expect(descriptors).toHaveLength(4);
  expect(
    descriptors.some(({ tag_name }) => tag_name === "CHAIN_PARTITION"),
  ).toBe(false);
});

it("inventories stored ranges and matches the chain key digest", async () => {
  const bytes = sampleAndroidVbmeta();
  const path = await writeCarrier("vbmeta.img", bytes);
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.manifest.root_format).toBe("android-vbmeta");
  expect(snapshot.coverage.status).toBe("complete");
  expect(snapshot.limitations).toContain(ANDROID_VBMETA_LIMITATIONS.unverified);
  expect(
    snapshot.occurrences.find((row) => row.logical_path === ".")
      ?.format_metadata,
  ).toMatchObject({ descriptor_failure: null });
  expect(snapshot.limitations.join(" ")).toContain(
    "AVB footers on partition images other than boot images are out of scope",
  );
  const root = snapshot.occurrences.find((row) => row.logical_path === ".");
  expect(root?.format_metadata).toMatchObject({
    kind: "android-vbmeta",
    algorithm_name: "SHA256_RSA2048",
    flag_names: ["HASHTREE_DISABLED", "VERIFICATION_DISABLED"],
    signatures_verified: false,
    public_key_sha256: sha256Hex(SAMPLE_PUBLIC_KEY),
  });
  const chain = (
    root?.format_metadata?.kind === "android-vbmeta"
      ? root.format_metadata.descriptors
      : []
  ).find((descriptor) => descriptor.tag_name === "CHAIN_PARTITION");
  expect(chain).toMatchObject({
    public_key_sha256: sha256Hex(SAMPLE_PUBLIC_KEY),
  });
  const publicKey = snapshot.occurrences.find(
    (row) => row.logical_path === "public_key",
  );
  expect(publicKey).toMatchObject({
    format_metadata: { kind: "android-vbmeta-entry", role: "public-key" },
    source_location: { length: SAMPLE_PUBLIC_KEY.length },
  });
  const node = snapshot.nodes.find(
    (row) => row.artifact_id === publicKey?.artifact_id,
  );
  expect(node?.sha256).toBe(sha256Hex(SAMPLE_PUBLIC_KEY));
  expect(node?.sha256).toBe(
    chain?.tag_name === "CHAIN_PARTITION" ? chain.public_key_sha256 : undefined,
  );

  const reader = new AndroidVbmetaArtifactReader(path);
  const stored = new Map<string, Buffer>();
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const metadata = reader.formatMetadata();
    if (!metadata) throw new Error("expected prepared vbmeta metadata");
    const expected = structuredClone(metadata);
    metadata.descriptors.pop();
    metadata.flag_names.pop();
    expect(reader.formatMetadata()).toEqual(expected);
    for (const entry of entries)
      stored.set(entry.path, await collect(await reader.open(entry)));
  } finally {
    await reader.close();
  }
  expect(stored.get("public_key")?.equals(SAMPLE_PUBLIC_KEY)).toBe(true);
  expect(
    stored.get("public_key_metadata")?.equals(SAMPLE_PUBLIC_KEY_METADATA),
  ).toBe(true);
  expect(
    createHash("sha256").update(stored.get("public_key")!).digest("hex"),
  ).toBe(node?.sha256);
  const carrier = await readFile(path);
  expect(carrier.equals(bytes)).toBe(true);
});

it("keeps parser refusal kinds on the reader", async () => {
  for (const fixture of androidVbmetaRefusals()) {
    const path = await writeCarrier(`${fixture.name}.img`, fixture.bytes);
    await expect(
      scanCanonicalArtifactInventory(path),
      fixture.name,
    ).rejects.toMatchObject(
      fixture.kind === "limit"
        ? { reason: "limit", boundary: "capacity" }
        : { reason: fixture.kind },
    );
  }
});

it("keeps decoded descriptors before a malformed one and names it", async () => {
  const path = await writeCarrier(
    "malformed-later.img",
    androidVbmetaMalformedLaterDescriptor(),
  );
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.manifest.root_format).toBe("android-vbmeta");
  expect(snapshot.coverage.status).toBe("unknown");
  expect(snapshot.occurrences.map(({ logical_path }) => logical_path)).toEqual([
    ".",
  ]);
  expect(snapshot.limitations.join(" ")).toContain(
    "Descriptor walk stopped at file offset",
  );
  const root = snapshot.occurrences.find((row) => row.logical_path === ".");
  const metadata =
    root?.format_metadata?.kind === "android-vbmeta"
      ? root.format_metadata
      : undefined;
  expect(metadata?.descriptors.map(({ tag_name }) => tag_name)).toEqual([
    "PROPERTY",
    "HASHTREE",
  ]);
  expect(metadata?.descriptor_failure).toMatchObject({
    kind: "malformed",
    field: "hash algorithm",
  });
});

it("keeps the header and stored ranges when the first descriptor stops the walk", async () => {
  const bytes = sampleAndroidVbmeta();
  const first =
    256 + Number(bytes.readBigUInt64BE(12)) + Number(bytes.readBigUInt64BE(96));
  bytes.writeBigUInt64BE(1n << 63n, first + 16);
  const snapshot = await scanCanonicalArtifactInventory(
    await writeCarrier("malformed-first.img", bytes),
  );
  expect(snapshot.coverage.status).toBe("unknown");
  expect(
    snapshot.occurrences.map(({ logical_path }) => logical_path).sort(),
  ).toEqual([".", "authentication_block", "public_key", "public_key_metadata"]);
  const root = snapshot.occurrences.find((row) => row.logical_path === ".");
  expect(root?.format_metadata).toMatchObject({
    kind: "android-vbmeta",
    public_key_sha256: sha256Hex(SAMPLE_PUBLIC_KEY),
    descriptors: [],
    descriptor_failure: { descriptor_offset: first, offset: first + 16 },
  });
});
