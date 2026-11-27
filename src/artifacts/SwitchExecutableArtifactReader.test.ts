import { buffer } from "node:stream/consumers";

import { expect, it } from "vitest";

import { classifyArtifactBytesAtPath } from "../../tests/fixtures/artifactClassification.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";
import { createTestTempFile } from "../../tests/fixtures/temporaryDirectory.js";
import {
  buildNro,
  buildNso,
  defaultText,
  MODULE_ID,
} from "../domain/switchExecutable.fixture.js";
import { SwitchExecutableArtifactReader } from "./SwitchExecutableArtifactReader.js";

const writeCarrier = (name: string, bytes: Buffer): Promise<string> =>
  createTestTempFile("rea-switch-", name, bytes);

it("classifies NSO and NRO executables by magic", () => {
  expect(classifyArtifactBytesAtPath("main", buildNso())).toEqual({
    kind: "container",
    format: "nso",
  });
  expect(classifyArtifactBytesAtPath("app.nro", buildNro())).toEqual({
    kind: "container",
    format: "nro",
  });
});

it("inventories NSO segments with module id, offsets and hash status", async () => {
  const path = await writeCarrier("main.nso", buildNso());
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.manifest.root_format).toBe("nso");
  expect(snapshot.coverage.status).toBe("complete");
  const root = snapshot.occurrences.find((row) => row.logical_path === ".");
  expect(root?.format_metadata).toMatchObject({
    kind: "switch-executable",
    format: "nso",
    module_id: MODULE_ID.toString("hex"),
    mod0_offset: 0x10,
    unknown_flags: 0,
    asset_section: null,
  });
  const segments = snapshot.occurrences
    .filter((row) => row.logical_path !== ".")
    .map((row) => [row.logical_path, row.format_metadata])
    .sort();
  expect(segments).toEqual([
    [
      "data.bin",
      expect.objectContaining({
        role: "data",
        compressed: true,
        hash_status: "match",
        memory_offset: 0x2000,
      }),
    ],
    [
      "rodata.bin",
      expect.objectContaining({
        role: "rodata",
        compressed: false,
        hash_status: "match",
      }),
    ],
    [
      "text.bin",
      expect.objectContaining({
        role: "text",
        compressed: true,
        hash_status: "match",
        file_offset: 0x100,
      }),
    ],
  ]);
});

it("serves compressed NSO segments as their decompressed bytes", async () => {
  const path = await writeCarrier("main.nso", buildNso());
  const reader = new SwitchExecutableArtifactReader(path, "nso");
  try {
    const contents = new Map<string, Buffer>();
    for await (const entry of reader.entries())
      contents.set(entry.path, await buffer(await reader.open(entry)));
    expect(contents.get("text.bin")?.equals(defaultText())).toBe(true);
    expect(contents.get("rodata.bin")?.toString()).toBe(
      "read-only data segment",
    );
    expect(contents.get("data.bin")?.toString()).toBe("writable data");
  } finally {
    await reader.close();
  }
});

it("reports a hash mismatch as a limitation without dropping the segment", async () => {
  const path = await writeCarrier("bad-hash.nso", buildNso({ corruptHash: 1 }));
  const reader = new SwitchExecutableArtifactReader(path, "nso");
  try {
    const entries = [];
    let coverage;
    for await (const entry of reader.entries(undefined, {
      onCoverage: (value) => (coverage = value),
    }))
      entries.push(entry);
    expect(entries.map((entry) => entry.path)).toEqual([
      "text.bin",
      "rodata.bin",
      "data.bin",
    ]);
    expect(entries[1]?.formatMetadata).toMatchObject({
      hash_status: "mismatch",
    });
    expect(entries[1]?.limitations.join(" ")).toContain("does not match");
    expect(coverage).toMatchObject({ status: "unknown" });
  } finally {
    await reader.close();
  }
});

it("reports not-checked when the header does not ask for a hash check", async () => {
  const path = await writeCarrier(
    "nocheck.nso",
    buildNso({ hashCheck: [false, false, false], corruptHash: 0 }),
  );
  const reader = new SwitchExecutableArtifactReader(path, "nso");
  try {
    const statuses = [];
    for await (const entry of reader.entries())
      statuses.push(
        (entry.formatMetadata as { hash_status: string }).hash_status,
      );
    expect(statuses).toEqual(["not-checked", "not-checked", "not-checked"]);
  } finally {
    await reader.close();
  }
});

it("inventories NRO segments and ASET icon, NACP and RomFS", async () => {
  const path = await writeCarrier(
    "app.nro",
    buildNro({
      assets: {
        icon: Buffer.from("icon-bytes"),
        nacp: Buffer.from("nacp-bytes"),
        romfs: Buffer.from("romfs-bytes"),
      },
    }),
  );
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.manifest.root_format).toBe("nro");
  expect(snapshot.coverage.status).toBe("complete");
  const root = snapshot.occurrences.find((row) => row.logical_path === ".");
  expect(root?.format_metadata).toMatchObject({
    kind: "switch-executable",
    format: "nro",
    mod0_offset: 0x80,
    mod0_present: true,
    asset_section: { offset: 0xb2, version: 0 },
  });
  expect(snapshot.occurrences.map((row) => row.logical_path).sort()).toEqual([
    ".",
    "assets/control.nacp",
    "assets/icon.jpg",
    "assets/romfs.bin",
    "data.bin",
    "rodata.bin",
    "text.bin",
  ]);
  const reader = new SwitchExecutableArtifactReader(path, "nro");
  try {
    for await (const entry of reader.entries())
      if (entry.path === "assets/romfs.bin")
        expect((await buffer(await reader.open(entry))).toString()).toBe(
          "romfs-bytes",
        );
  } finally {
    await reader.close();
  }
});

it("marks the NRO asset section absent when no ASET follows", async () => {
  const path = await writeCarrier("plain.nro", buildNro());
  const snapshot = await scanCanonicalArtifactInventory(path);
  const root = snapshot.occurrences.find((row) => row.logical_path === ".");
  expect(root?.format_metadata).toMatchObject({ asset_section: null });
  expect(snapshot.coverage.status).toBe("complete");
});
