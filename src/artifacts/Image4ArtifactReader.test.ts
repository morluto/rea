import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";

import { expect, it } from "vitest";

import { extractArtifact } from "./extraction/ArtifactExtraction.js";
import { Image4ArtifactReader } from "./Image4ArtifactReader.js";
import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";
import {
  SAMPLE_IV,
  SAMPLE_KEY,
  SAMPLE_PAYLOAD,
  im4m,
  im4p,
  img4,
  keybag,
  tlv,
} from "../domain/apple/image4.fixture.js";
import {
  createTestTempDirectory,
  createTestTempFile,
} from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";

const writeImage = (name: string, bytes: Buffer): Promise<string> =>
  createTestTempFile("rea-img4-", name, bytes);

const readAll = async (reader: Image4ArtifactReader) => {
  const coverage: unknown[] = [];
  const entries = [];
  for await (const entry of reader.entries(undefined, {
    onCoverage: (value) => coverage.push(value),
  }))
    entries.push(entry);
  return { entries, coverage, metadata: reader.formatMetadata() };
};

it("inventories an IM4P payload and extracts the stored bytes", async () => {
  const bytes = im4p();
  const path = await writeImage("kernelcache.im4p", bytes);
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.manifest.root_format).toBe("apple-img4");
  expect(snapshot.coverage).toMatchObject({
    scope: "container-entries",
    status: "complete",
  });
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "."),
  ).toMatchObject({
    format_metadata: {
      kind: "apple-img4",
      magic: "IM4P",
      payload: {
        type: "krnl",
        description: "Kernelcache",
        encrypted: false,
        compression: "none",
      },
    },
  });
  const directory = await createTestTempDirectory("rea-img4-extract-");
  const resourceScope = new ArtifactResourceScope();
  try {
    const extracted = await extractArtifact({
      inputPath: path,
      inputFormat: "apple-img4",
      outputRoot: join(directory, "out"),
      environment: process.env,
      integrityPolicy: "fail",
      resourceScope,
    });
    expect(
      (await readFile(join(extracted.output_root, "payload"))).equals(
        SAMPLE_PAYLOAD,
      ),
    ).toBe(true);
  } finally {
    await resourceScope.close();
  }
});

it("extracts an IMG4 manifest and restore info and refuses an encrypted payload", async () => {
  const payload = Buffer.from("kernel-bytes");
  const file = img4(
    im4p({
      payload,
      keybag: keybag([{ type: 1, iv: SAMPLE_IV, key: SAMPLE_KEY }]),
    }),
    im4m({ digest: Buffer.alloc(32, 0xab) }),
  );
  const path = await writeImage("firmware.img4", file);
  const reader = new Image4ArtifactReader(path);
  try {
    const { entries, metadata } = await readAll(reader);
    expect(entries.map((entry) => entry.path)).toEqual([
      "payload",
      "manifest.der",
      "restore-info.der",
    ]);
    const payloadEntry = entries[0];
    expect(payloadEntry).toMatchObject({
      encrypted: true,
      unpacked: false,
      formatMetadata: {
        kind: "apple-img4-entry",
        decoded: false,
        role: "payload",
      },
    });
    await expect(reader.open(payloadEntry!)).rejects.toMatchObject({
      reason: "unavailable",
    });
    const manifest = await buffer(await reader.open(entries[1]!));
    expect(manifest[0]).toBe(0x30);
    expect(manifest.includes(Buffer.from("IM4M"))).toBe(true);
    const restore = await buffer(await reader.open(entries[2]!));
    expect(restore[0]).toBe(0x30);
    expect(restore.includes(Buffer.from("BNCN"))).toBe(true);
    const json = JSON.stringify(metadata);
    expect(json).not.toContain(SAMPLE_IV.toString("hex"));
    expect(json).not.toContain(SAMPLE_KEY.toString("hex"));
    expect(json).not.toContain("BOOTNONCE-SECRET-VALUE!!");
  } finally {
    await reader.close();
  }
});

it("marks an LZVN bvxn payload compressed and returns the stored bytes", async () => {
  const payload = Buffer.from("bvxn-stored-bytes");
  const path = await writeImage("kernelcache-lzvn.im4p", im4p({ payload }));
  const reader = new Image4ArtifactReader(path);
  try {
    const { entries, coverage, metadata } = await readAll(reader);
    expect(coverage).toEqual([{ status: "complete", limitations: [] }]);
    expect(entries[0]).toMatchObject({
      encrypted: false,
      unpacked: false,
      declaredSize: payload.length,
      compressedSize: payload.length,
      formatMetadata: {
        decoded: false,
        compression: "bvxn",
        encrypted: false,
      },
    });
    expect(metadata?.payload).toMatchObject({
      compression: "bvxn",
      payload_magic: "bvxn",
    });
    expect((await buffer(await reader.open(entries[0]!))).equals(payload)).toBe(
      true,
    );
  } finally {
    await reader.close();
  }
});

it("returns stored bvx2 bytes and does not mark them decoded", async () => {
  const payload = Buffer.from("bvx2-stored-bytes");
  const path = await writeImage("kernelcache.im4p", im4p({ payload }));
  const reader = new Image4ArtifactReader(path);
  try {
    const { entries, coverage } = await readAll(reader);
    expect(coverage).toEqual([{ status: "complete", limitations: [] }]);
    expect(entries[0]).toMatchObject({
      encrypted: false,
      unpacked: false,
      declaredSize: payload.length,
      compressedSize: payload.length,
      formatMetadata: {
        decoded: false,
        compression: "bvx2",
        encrypted: false,
      },
    });
    expect((await buffer(await reader.open(entries[0]!))).equals(payload)).toBe(
      true,
    );
  } finally {
    await reader.close();
  }
});

it("lists only the manifest for IM4M and only the payload for IM4P", async () => {
  const manifestReader = new Image4ArtifactReader(
    await writeImage("manifest.im4m", im4m()),
  );
  const payloadReader = new Image4ArtifactReader(
    await writeImage("payload.im4p", im4p()),
  );
  try {
    expect(
      (await readAll(manifestReader)).entries.map((entry) => entry.path),
    ).toEqual(["manifest.der"]);
    expect(
      (await readAll(payloadReader)).entries.map((entry) => entry.path),
    ).toEqual(["payload"]);
  } finally {
    await manifestReader.close();
    await payloadReader.close();
  }
});

it("refuses to open a payload whose keybag is a constructed OCTET STRING", async () => {
  const bag = keybag([{ type: 1, iv: SAMPLE_IV, key: SAMPLE_KEY }]);
  const path = await writeImage(
    "constructed-keybag.im4p",
    im4p({ keybag: tlv(0x24, bag) }),
  );
  const reader = new Image4ArtifactReader(path);
  try {
    const { entries, coverage } = await readAll(reader);
    expect(entries[0]).toMatchObject({ path: "payload", encrypted: true });
    await expect(reader.open(entries[0]!)).rejects.toMatchObject({
      reason: "unavailable",
    });
    expect(JSON.stringify(coverage)).not.toContain('"complete"');
  } finally {
    await reader.close();
  }
});
