import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseLabviewRsrc } from "./LabviewRsrc.js";
import { LabviewArtifactProvider } from "./LabviewArtifactProvider.js";
import {
  buildLabviewRsrc,
  labviewContainer,
} from "../../tests/fixtures/labview/rsrc.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

describe("parseLabviewRsrc", () => {
  it("inventories blocks and section codings from one container", () => {
    const parsed = parseLabviewRsrc(labviewContainer());
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
      buildLabviewRsrc([
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
    expect(parseLabviewRsrc(labviewContainer().subarray(0, 40))).toMatchObject({
      ok: false,
    });
  });
});

describe("LabviewArtifactProvider", () => {
  it("inspects a selected RSRC file and binds its identity", async () => {
    const root = await createTestTempDirectory("rea-labview-rsrc-");
    const path = join(root, "fixture.vi");
    const bytes = labviewContainer();
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

  it("reports caller cancellation before the selected artifact is read", async () => {
    const controller = new AbortController();
    const reason = { request: "cancel LabVIEW inspection" };
    controller.abort(reason);
    const provider = new LabviewArtifactProvider();
    const result = await provider.inspect(
      { path: "/nonexistent/fixture.vi" },
      { signal: controller.signal },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe("AnalysisCancelledError");
      expect(result.error.cause).toBe(reason);
    }
    await provider.close();
  });
});
