import { deflateSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseLabviewRsrc } from "./LabviewRsrc.js";
import { LabviewArtifactProvider } from "./LabviewArtifactProvider.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

interface BlockFixture {
  readonly ident: string;
  readonly sections: readonly Buffer[];
}

const u32 = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};

/**
 * Build one synthetic RSRC container with the header, block-info list, and
 * section data this reader parses. Names are omitted; the container's own
 * offsets are the fact under test, not a producer's naming.
 */
const buildRsrc = (blocks: readonly BlockFixture[]): Buffer => {
  const dataParts: Buffer[] = [];
  const sectionArrays: Buffer[] = [];
  let dataLength = 0;
  for (const block of blocks) {
    const starts: Buffer[] = [];
    for (const section of block.sections) {
      const at = dataLength;
      dataParts.push(u32(section.length), section);
      dataLength += 4 + section.length;
      const pad = (4 - (dataLength % 4)) % 4;
      if (pad > 0) {
        dataParts.push(Buffer.alloc(pad));
        dataLength += pad;
      }
      const start = Buffer.alloc(20);
      start.writeInt32BE(0, 0);
      start.writeUInt32BE(0xffffffff, 4);
      start.writeUInt32BE(0, 8);
      start.writeUInt32BE(at, 12);
      start.writeUInt32BE(0, 16);
      starts.push(start);
    }
    sectionArrays.push(Buffer.concat(starts));
  }
  const data = Buffer.concat(dataParts);
  const dataOffset = 32;
  const infoOffset = dataOffset + data.length;
  const headersLength = 12 * blocks.length;
  const blockHeaders: Buffer[] = [];
  let cursor = 4 + headersLength;
  for (let index = 0; index < blocks.length; index += 1) {
    const header = Buffer.alloc(12);
    header.write(blocks[index]?.ident ?? "????", 0, 4, "latin1");
    header.writeUInt32BE((blocks[index]?.sections.length ?? 1) - 1, 4);
    header.writeUInt32BE(cursor, 8);
    blockHeaders.push(header);
    cursor += sectionArrays[index]?.length ?? 0;
  }
  const blockInfo = Buffer.concat([
    u32(blocks.length - 1),
    ...blockHeaders,
    ...sectionArrays,
  ]);
  const listHeader = Buffer.alloc(20);
  listHeader.writeUInt32BE(0, 0);
  listHeader.writeUInt32BE(0, 4);
  listHeader.writeUInt32BE(32, 8);
  listHeader.writeUInt32BE(52, 12);
  listHeader.writeUInt32BE(blockInfo.length, 16);
  const infoLength = 32 + listHeader.length + blockInfo.length;
  const header = (): Buffer => {
    const bytes = Buffer.alloc(32);
    bytes.write("RSRC\r\n", 0, 6, "latin1");
    bytes.writeUInt16BE(3, 6);
    bytes.write("LVAR", 8, 4, "latin1");
    bytes.write("LBVW", 12, 4, "latin1");
    bytes.writeUInt32BE(infoOffset, 16);
    bytes.writeUInt32BE(infoLength, 20);
    bytes.writeUInt32BE(dataOffset, 24);
    bytes.writeUInt32BE(data.length, 28);
    return bytes;
  };
  return Buffer.concat([header(), data, header(), listHeader, blockInfo]);
};

const zlibSection = (text: string): Buffer => {
  const encoded = deflateSync(Buffer.from(text, "latin1"));
  return Buffer.concat([u32(Buffer.byteLength(text, "latin1")), encoded]);
};

const versionSection = (): Buffer => {
  const bytes = Buffer.alloc(12);
  bytes.write("11.0", 0, 4, "latin1");
  return bytes;
};

const container = (): Buffer =>
  buildRsrc([
    { ident: "vers", sections: [versionSection()] },
    { ident: "DFDS", sections: [zlibSection("hello"), Buffer.from("raw!")] },
  ]);

describe("parseLabviewRsrc", () => {
  it("inventories blocks and section codings from one container", () => {
    const parsed = parseLabviewRsrc(container());
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.value).toMatchObject({
      formatVersion: 3,
      fileType: "LVAR",
      creator: "LBVW",
      dataOffset: 32,
      labviewVersion: "11.0",
      blockDiagram: "absent",
      frontPanel: "absent",
    });
    const dfds = parsed.value.blocks.find(
      ({ identifier }) => identifier === "DFDS",
    );
    expect(
      dfds?.sections.map(({ coding, decodedBytes }) => ({
        coding,
        decodedBytes,
      })),
    ).toEqual([
      { coding: "zlib", decodedBytes: 5 },
      { coding: "none", decodedBytes: null },
    ]);
    expect(dfds?.sections[1]?.storedBytes).toBe(4);
  });

  it("reports the XOR-coded program tree and retained heaps", () => {
    const parsed = parseLabviewRsrc(
      buildRsrc([
        { ident: "LVzp", sections: [Buffer.from("\x00\x00\x00\x01abc")] },
        { ident: "BDHc", sections: [Buffer.from("diagram")] },
        { ident: "FPHb", sections: [Buffer.from("panel")] },
      ]),
    );
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.value.blockDiagram).toBe("present");
    expect(parsed.value.frontPanel).toBe("present");
    expect(parsed.value.blocks[0]?.sections[0]).toMatchObject({
      coding: "xor",
      decodedBytes: null,
    });
  });

  it("fails a truncated or non-RSRC container instead of returning a partial inventory", () => {
    expect(parseLabviewRsrc(Buffer.from("not a container"))).toMatchObject({
      ok: false,
    });
    expect(parseLabviewRsrc(container().subarray(0, 40))).toMatchObject({
      ok: false,
    });
  });
});

describe("LabviewArtifactProvider", () => {
  it("inspects a selected RSRC file and binds its identity", async () => {
    const root = await createTestTempDirectory("rea-labview-rsrc-");
    const path = join(root, "fixture.vi");
    const bytes = container();
    await writeFile(path, bytes);
    const provider = new LabviewArtifactProvider();
    const result = await provider.inspect({ path });
    if (!result.ok) throw result.error;
    expect(result.value.artifact).toMatchObject({ path, bytes: bytes.length });
    expect(result.value.artifact.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.value.container).toMatchObject({
      kind: "rsrc",
      embedded_containers: 1,
    });
    expect(result.value.labview_version).toBe("11.0");
    await provider.close();
  });

  it("refuses a selected file that is not a LabVIEW container", async () => {
    const root = await createTestTempDirectory("rea-labview-bad-");
    const path = join(root, "fixture.bin");
    await writeFile(path, Buffer.from("not a LabVIEW artifact"));
    const provider = new LabviewArtifactProvider();
    const result = await provider.inspect({ path });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisInputError");
    await provider.close();
  });
});
