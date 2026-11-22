import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";
import { cliTest } from "../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import {
  ESP32C3_APP_SEGMENTS,
  ESP32C3_BOOTLOADER_SEGMENTS,
  espImage,
} from "../fixtures/espImage.js";
import {
  TWO_OTA_PARTITIONS,
  espFlashDump,
  otaData,
  otaRecord,
  partitionEntry,
  partitionTable,
} from "../../src/domain/firmware/espFlash.fixture.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../src/domain/artifactGraph.js";

const rootMetadata = (json: unknown) => {
  const graph = artifactInventoryResultSchema.parse(
    artifactInspectionResultSchema.parse(parseEvidence(json).normalized_result)
      .substeps[0]?.evidence.normalized_result,
  );
  return {
    graph,
    root: graph.occurrences.find(({ logical_path }) => logical_path === ".")
      ?.format_metadata,
  };
};

cliTest.for([
  {
    label: "valid-early",
    layout: "early",
    md5: "valid",
    basis: "unknown",
    index: null,
    after: 1,
  },
  {
    label: "corrupt-early",
    layout: "early",
    md5: "corrupt",
    basis: "none",
    index: null,
    after: 1,
  },
  {
    label: "repeated-md5",
    layout: "repeat",
    md5: "valid",
    basis: "none",
    index: null,
    after: 1,
  },
  {
    label: "checksum-first",
    layout: "first",
    md5: "valid",
    basis: "unknown",
    index: null,
    after: 1,
  },
  {
    label: "valid-trailing",
    layout: "trailing",
    md5: "valid",
    basis: "no-otadata",
    index: 1,
    after: 0,
  },
  {
    label: "no-checksum",
    layout: "trailing",
    md5: "absent",
    basis: "no-otadata",
    index: 1,
    after: 0,
  },
] as const)(
  "qualifies boot selection without losing checksum coverage through CLI and MCP: $label",
  async ({ label, layout, md5, basis, index, after }, { cli }) => {
    const nvs = TWO_OTA_PARTITIONS.find((part) => part.label === "nvs");
    const factory = TWO_OTA_PARTITIONS.find((part) => part.label === "factory");
    if (nvs === undefined || factory === undefined)
      throw new Error("Missing partition fixture");
    const table =
      layout === "trailing"
        ? partitionTable([nvs, factory], { md5 })
        : partitionTable(layout === "first" ? [] : [nvs], { md5 });
    if (layout === "first") partitionEntry(factory).copy(table, 32);
    if (layout === "early" || layout === "repeat")
      partitionEntry(factory).copy(table, 64);
    if (layout === "repeat")
      Buffer.from(table.subarray(32, 64)).copy(table, 96);
    const dump = espFlashDump({
      size: 0x20000,
      table,
      bootloader: {
        at: 0,
        bytes: espImage({ segments: ESP32C3_BOOTLOADER_SEGMENTS }),
      },
    });
    const directory = await createTestTempDirectory("rea-esp-checksum-boot-");
    const path = join(directory, `${label}.bin`);
    await writeFile(path, dump);
    const result = await cli.run({
      arguments: [
        "inspect-artifact",
        path,
        "--target-format",
        "esp-flash-image",
        "--partition-table-offset",
        "0x8000",
        "--json",
      ],
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const cliReport = rootMetadata(result.json);
    const call = await cli.sharedMcpCall?.();
    if (call === undefined) throw new Error("Expected a stdio MCP session");
    const opened = await call("open_binary", {
      path,
      format: "esp-flash-image",
      partition_table_offset: "0x8000",
    });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    try {
      const inspected = await call("inspect_artifact", {});
      expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
      const mcpReport = rootMetadata(inspected.structuredContent);
      expect(mcpReport.graph).toEqual(cliReport.graph);
      expect(cliReport.graph.manifest.root_sha256).toBe(
        createHash("sha256").update(dump).digest("hex"),
      );
      if (cliReport.root?.kind !== "esp-flash-image")
        throw new Error("Expected ESP flash metadata");
      const checksum = cliReport.root.partition_table.md5;
      if (md5 === "absent") {
        expect(checksum.stored).toBeNull();
        expect(checksum.computed).toBeNull();
      } else {
        expect(checksum.stored).toMatch(/^[0-9a-f]{32}$/u);
        expect(checksum.computed).toMatch(/^[0-9a-f]{32}$/u);
        if (md5 === "corrupt")
          expect(checksum.stored).not.toBe(checksum.computed);
        else expect(checksum.stored).toBe(checksum.computed);
      }
      if (after > 0)
        expect(cliReport.graph.limitations).toContainEqual(
          expect.stringMatching(
            /partition entries after the MD5 record.*outside its checksum coverage/iu,
          ),
        );
      if (basis === "unknown")
        expect(cliReport.graph.limitations).toContainEqual(
          expect.stringContaining("Boot selection is unknown."),
        );
      if (basis === "none") {
        expect(cliReport.graph.limitations).toContainEqual(
          expect.stringMatching(/rejects the table/iu),
        );
        expect(
          cliReport.graph.limitations.some((item) =>
            item.includes("Boot selection is unknown."),
          ),
        ).toBe(false);
      }
      if (after === 0)
        expect(
          cliReport.graph.limitations.some((item) =>
            item.includes("outside its checksum coverage"),
          ),
        ).toBe(false);
      expect(cliReport.root).toMatchObject({
        kind: "esp-flash-image",
        partition_table: {
          flash_address: 0x8000,
          method: "caller",
          partition_count: layout === "first" ? 1 : 2,
          md5: {
            status:
              layout === "repeat"
                ? "invalid"
                : md5 === "corrupt"
                  ? "invalid"
                  : md5,
            entries_after_checksum: after,
          },
        },
        boot_selection: {
          basis,
          partition_index: index,
          active_record: null,
          slot: null,
          running_partition: "unknown",
        },
      });
      expect(cliReport.graph.occurrences).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            logical_path: "partitions/factory.bin",
            format_metadata: expect.objectContaining({
              label: "factory",
              index: layout === "first" ? 0 : 1,
            }),
          }),
        ]),
      );
      if (layout !== "first")
        expect(cliReport.graph.occurrences).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              logical_path: "partitions/nvs.bin",
              format_metadata: expect.objectContaining({
                label: "nvs",
                index: 0,
              }),
            }),
          ]),
        );
      expect((await readFile(path)).equals(dump)).toBe(true);
    } finally {
      const closed = await call("close_binary", {});
      expect(closed.isError, JSON.stringify(closed)).not.toBe(true);
    }
  },
);

cliTest(
  "inventories and extracts a whole-flash dump through the compiled CLI",
  async ({ cli }) => {
    const directory = await createTestTempDirectory("rea-esp-flash-cli-");
    const source = join(directory, "flash.bin");
    const app = espImage({ segments: ESP32C3_APP_SEGMENTS });
    const dump = espFlashDump({
      bootloader: {
        at: 0,
        bytes: espImage({ segments: ESP32C3_BOOTLOADER_SEGMENTS }),
      },
      parts: [
        { at: 0xd000, bytes: otaData(otaRecord({ seq: 2 })) },
        { at: 0x2_0000, bytes: app },
        { at: 0x3_0000, bytes: app },
      ],
    });
    await writeFile(source, dump);
    const inspected = await cli.run({
      arguments: ["inspect-artifact", source, "--json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);
    const { graph, root } = rootMetadata(inspected.json);
    expect(graph.manifest.root_format).toBe("esp-flash-image");
    expect(root).toMatchObject({
      kind: "esp-flash-image",
      chip: { target: "esp32c3" },
      partition_table: { method: "default", md5: { status: "valid" } },
      boot_selection: {
        basis: "otadata",
        slot: 1,
        partition_index: 5,
        running_partition: "unknown",
      },
    });
    const extracted = await cli.run({
      arguments: ["extract-artifact", source, "--json"],
      environment: { TMPDIR: directory, TMP: directory, TEMP: directory },
    });
    expect(extracted.exitCode, extracted.stdout + extracted.stderr).toBe(0);
    const result = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.json).normalized_result,
    );
    onTestFinished(() =>
      rm(result.output_root, { recursive: true, force: true }),
    );
    expect(
      Buffer.compare(
        await readFile(join(result.output_root, "partitions/ota_1.bin")),
        dump.subarray(0x3_0000, 0x4_0000),
      ),
    ).toBe(0);
  },
);

cliTest(
  "reads a dump from a caller-selected flash offset and refuses unpaired inputs",
  async ({ cli }) => {
    const directory = await createTestTempDirectory(
      "rea-esp-flash-cli-origin-",
    );
    const source = join(directory, "from-0x1000.bin");
    const esp32 = espImage({
      segments: ESP32C3_BOOTLOADER_SEGMENTS,
      chipId: 0x0000,
    });
    await writeFile(
      source,
      espFlashDump({ bootloader: { at: 0x1000, bytes: esp32 } }).subarray(
        0x1000,
      ),
    );
    const unpaired = await cli.run({
      arguments: [
        "inspect-artifact",
        source,
        "--flash-offset",
        "0x1000",
        "--json",
      ],
    });
    expect(unpaired.exitCode).not.toBe(0);
    expect(unpaired.stdout + unpaired.stderr).toMatch(
      /flash_offset.*only with format=esp-flash-image/iu,
    );
    // Without the format, the bootloader is read as one ESP image, and the
    // table at file offset 0x7000 says how to reopen the dump.
    const automatic = await cli.run({
      arguments: ["inspect-artifact", source, "--json"],
    });
    expect(automatic.exitCode, automatic.stdout + automatic.stderr).toBe(0);
    const guessed = rootMetadata(automatic.json);
    expect(guessed.graph.manifest.root_format).toBe("esp-image");
    expect(guessed.root).toMatchObject({
      flash_dump: { flash_offset: 0x1000, table_file_offset: 0x7000 },
    });
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(automatic.json).normalized_result,
    );
    expect(inspection.next_probes).toEqual([
      expect.objectContaining({
        operation: "open_binary",
        authority: "artifact-bytes",
        rationale: expect.stringMatching(
          /esp-flash-image.*flash_offset 0x1000.*0x7000/iu,
        ),
      }),
    ]);
    expect(guessed.graph.limitations).toContainEqual(
      expect.stringMatching(
        /flash dump.*0x1000.*0x7000.*0x8000.*esp-flash-image.*0x1000/iu,
      ),
    );
    const inspected = await cli.run({
      arguments: [
        "inspect-artifact",
        source,
        "--target-format",
        "esp-flash-image",
        "--flash-offset",
        "0x1000",
        "--json",
      ],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);
    expect(rootMetadata(inspected.json).root).toMatchObject({
      flash_offset: { value: 0x1000, source: "caller" },
      chip: { target: "esp32" },
      bootloader: { flash_address: 0x1000 },
    });
  },
);
