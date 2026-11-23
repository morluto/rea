import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "./ManagedPe.fixture.js";
import { ManagedStaticProvider } from "./ManagedStaticProvider.js";

it.each([
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
    // The authored PE32 fixture maps its CLI header to the start of .text.
    const headerOffset = 0x200;
    expect(bytes.readUInt32LE(headerOffset)).toBe(72);
    const directorySizeOffset = bytes.readUInt32LE(0x3c) + 24 + 96 + 14 * 8 + 4;
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
          pe: { machine: 0x014c, section_count: 1, cli: null },
          classification: { status: "malformed" },
          metadata: { status: "malformed" },
          coverage: {
            state: "partial",
            issues: [
              { code: "invalid-directory", scope: "cli.header", offset: null },
            ],
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
