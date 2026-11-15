import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { inspectManagedArtifactBytes } from "./ManagedArtifactInspector.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";
import { readManagedPeLayout } from "./ManagedPeReader.js";
import { ManagedStaticProvider } from "./ManagedStaticProvider.js";

it.each([
  { name: "fixed header", size: 72, virtualSize: 4096, valid: true },
  { name: "backed extension", size: 80, virtualSize: 4096, valid: true },
  { name: "outside file backing", size: 3585, virtualSize: 4096, valid: false },
  {
    name: "outside virtual mapping",
    size: 3073,
    virtualSize: 3072,
    valid: false,
  },
])(
  "admits the complete declared CLI header: $name",
  async ({ size, virtualSize, valid }) => {
    const bytes = buildManagedPeFixture({ virtualSectionSize: virtualSize });
    const original = readManagedPeLayout(bytes);
    if (original.cli === null) throw new Error("Fixture lacks a CLI header");
    const headerOffset = original.cli.headerOffset;
    const optionalOffset = bytes.readUInt32LE(0x3c) + 24;
    // This source-owned fixture is PE32; directory 14 declares its CLI extent.
    const directorySizeOffset = optionalOffset + 96 + 14 * 8 + 4;
    expect(
      inspectManagedArtifactBytes(bytes, managedPeFixtureTarget(bytes)).metadata
        .status,
    ).toBe("complete");
    bytes.writeUInt32LE(size, headerOffset);
    bytes.writeUInt32LE(size, directorySizeOffset);
    const root = await createTestTempDirectory("rea-managed-cli-range-");
    const path = join(root, "fixture.dll");
    await writeFile(path, bytes);
    const target = { ...managedPeFixtureTarget(bytes), path };
    const client = new ManagedStaticProvider().createClient(target);
    try {
      const execution = await client.execute("inspect_managed_artifact", {});
      if (!execution.ok) throw execution.error;
      const report = execution.value.result;
      if (valid) {
        expect(report).toMatchObject({
          metadata: { status: "complete" },
          pe: { cli: { header_offset: headerOffset, header_size: size } },
          coverage: { state: "complete", issues: [] },
        });
        expect(execution.value.locations).toContainEqual({
          kind: "file-offset-range",
          start: headerOffset,
          end: headerOffset + size,
        });
      } else {
        expect(report).toMatchObject({
          artifact: { sha256: target.sha256, byte_length: bytes.length },
          pe: { machine: original.machine, section_count: 1, cli: null },
          classification: { status: "malformed" },
          metadata: { status: "malformed" },
          coverage: {
            state: "partial",
            issues: [expect.objectContaining({ scope: "cli.header" })],
          },
        });
        expect(execution.value.locations).toEqual([
          { kind: "file-offset", offset: 0 },
        ]);
      }
    } finally {
      const closed = await client.close();
      expect(closed.ok).toBe(true);
    }
  },
);
