import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { peResourceFixture } from "../domain/pe/peResources.fixture.js";
import { findEmbeddedRsrcContainers } from "./LabviewPeContainer.js";
import { parseLabviewRsrc } from "./LabviewRsrc.js";
import {
  LabviewArtifactProvider,
  labviewReadDialect,
} from "./LabviewArtifactProvider.js";
import { ArtifactReaderFailure } from "../resources/index.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import {
  buildLabviewRsrc,
  labviewContainer,
  labviewVersionSection,
  labviewZlibSection,
} from "../../tests/fixtures/labview/rsrc.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

describe("parseLabviewRsrc", () => {
  it("inventories blocks and section codings from one container", () => {
    const parsed = parseLabviewRsrc(labviewContainer());
    if (!parsed.ok) throw new Error(parsed.failure.message);
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

  it("locates an RSRC container stored as a PE resource", () => {
    const bytes = peResourceFixture(true, [
      { type: 10, name: 1, language: 1033, payload: labviewContainer() },
    ]).bytes;
    const scan = findEmbeddedRsrcContainers(bytes);
    if (!scan.ok) throw scan.failure;
    expect(scan.containers).toHaveLength(1);
    expect(scan.containers[0]?.bytes.equals(labviewContainer())).toBe(true);
  });

  it("reads the version from a zlib-coded vers section", () => {
    const parsed = parseLabviewRsrc(
      buildLabviewRsrc([
        { ident: "vers", sections: [labviewZlibSection("11.0")] },
      ]),
    );
    if (!parsed.ok) throw new Error(parsed.failure.message);
    expect(parsed.value.blocks[0]?.sections[0]).toMatchObject({
      coding: "zlib",
      decodedBytes: 4,
    });
    expect(parsed.value.labviewVersion).toBe("11.0");
  });

  it("keeps each block's interpretation of shared stored bytes", () => {
    // Point the second block's section start at the first block's stored data.
    // The two blocks must keep their own coding: LVzp is XOR even when the
    // bytes it shares were classified for a DFDS block first.
    const container = buildLabviewRsrc([
      { ident: "DFDS", sections: [labviewZlibSection("hello")] },
      { ident: "LVzp", sections: [Buffer.from("ignored")] },
    ]);
    const infoOffset = container.readUInt32BE(16);
    const blockInfo = infoOffset + container.readUInt32BE(infoOffset + 44);
    const starts0 = container.readUInt32BE(blockInfo + 4 + 8);
    const starts1 = container.readUInt32BE(blockInfo + 4 + 12 + 8);
    const sharedOffset = container.readUInt32BE(blockInfo + starts0 + 12);
    container.writeUInt32BE(sharedOffset, blockInfo + starts1 + 12);
    const parsed = parseLabviewRsrc(container);
    if (!parsed.ok) throw new Error(parsed.failure.message);
    expect(parsed.value.blocks[0]?.sections[0]?.coding).toBe("zlib");
    expect(parsed.value.blocks[1]?.sections[0]?.coding).toBe("xor");
  });

  it("accepts a list extent that runs past the resource payload", () => {
    // A real LabVIEW-built PE declares more list bytes than its resource
    // payload holds; the records it actually uses still fit.
    const container = Buffer.from(labviewContainer());
    const infoOffset = container.readUInt32BE(16);
    container.writeUInt32BE(
      container.readUInt32BE(infoOffset + 48) + 1000,
      infoOffset + 48,
    );
    const parsed = parseLabviewRsrc(container);
    if (!parsed.ok) throw new Error(parsed.failure.message);
    expect(parsed.value.blocks.map(({ identifier }) => identifier)).toEqual([
      "vers",
      "DFDS",
    ]);
  });

  it("reports the XOR-coded program tree and retained heaps", () => {
    const parsed = parseLabviewRsrc(
      buildLabviewRsrc([
        { ident: "LVzp", sections: [Buffer.from("\x00\x00\x00\x01abc")] },
        { ident: "BDHc", sections: [Buffer.from("diagram")] },
        { ident: "FPHb", sections: [Buffer.from("panel")] },
      ]),
    );
    if (!parsed.ok) throw new Error(parsed.failure.message);
    expect(parsed.value.blockDiagram).toBe("present");
    expect(parsed.value.frontPanel).toBe("present");
    expect(parsed.value.blocks[0]?.sections[0]).toMatchObject({
      coding: "xor",
      decodedBytes: null,
    });
  });

  it("finds no version in a long digit-only section without rescanning", () => {
    // The bounded single-pass scan must not backtrack over the digit run.
    const parsed = parseLabviewRsrc(
      buildLabviewRsrc([
        { ident: "vers", sections: [Buffer.alloc(200_000, 0x30)] },
      ]),
    );
    if (!parsed.ok) throw new Error(parsed.failure.message);
    expect(parsed.value.labviewVersion).toBeNull();
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

  it("reports cancellation that arrives after the read starts", async () => {
    const root = await createTestTempDirectory("rea-labview-cancel-");
    const path = join(root, "fixture.vi");
    await writeFile(path, labviewContainer());
    const controller = new AbortController();
    const reason = { request: "cancel LabVIEW inspection" };
    const provider = new LabviewArtifactProvider();
    // Start the inspection, then cancel while its stable read is in flight.
    const pending = provider.inspect({ path }, { signal: controller.signal });
    controller.abort(reason);
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The read records the cancellation at its own owner; the public
      // projection is what callers act on.
      expect(projectAnalysisError(result.error).code).toBe("cancelled");
      expect(result.error.cause).toBe(reason);
    }
    await provider.close();
  });

  it("keeps heap presence unknown for a .llb archive", async () => {
    const root = await createTestTempDirectory("rea-labview-llb-");
    const path = join(root, "fixture.llb");
    await writeFile(path, labviewContainer());
    const provider = new LabviewArtifactProvider();
    const result = await provider.inspect({ path });
    if (!result.ok) throw result.error;
    // Member VIs inside the archive are not opened, so absence is not proven.
    expect(result.value.block_diagram).toBe("unknown");
    expect(result.value.front_panel).toBe("unknown");
    expect(result.value.limitations.join(" ")).toContain("member VI contents");
    await provider.close();
  });

  it("keeps failed cleanup with the input-size refusal", () => {
    const path = "/artifact/fixture.vi";
    const cause = new ArtifactReaderFailure(
      "limit",
      "Selected artifact exceeds the input allowance",
      {
        boundary: "file-size",
        cleanup: { reason: "descriptor close failed", resources: [path] },
      },
    );
    const projected = classifyProviderFailure(cause, labviewReadDialect(path));
    expect(projected.cleanupIncomplete).toBe(true);
    expect(projected.cleanupResources).toContain(path);
    const publicView = projectAnalysisError(projected);
    expect(publicView.details).toMatchObject({
      boundary: "file-size",
      truncated: true,
    });
  });

  it("states the input allowance when the size refusal has no pending cleanup", () => {
    const path = "/artifact/fixture.vi";
    const cause = new ArtifactReaderFailure(
      "limit",
      "Selected artifact exceeds the input allowance",
      {
        boundary: "file-size",
      },
    );
    const projected = classifyProviderFailure(cause, labviewReadDialect(path));
    const publicView = projectAnalysisError(projected);
    expect(publicView.details).toMatchObject({ boundary: "file-size" });
    expect(publicView.remediation.action).toContain(
      "256 MiB LabVIEW artifact input allowance",
    );
  });

  it("reports heap presence as unknown when content was not examined", async () => {
    const root = await createTestTempDirectory("rea-labview-unknown-");
    const path = join(root, "fixture.vi");
    await writeFile(
      path,
      buildLabviewRsrc([
        { ident: "vers", sections: [labviewVersionSection()] },
        { ident: "LVzp", sections: [Buffer.from("\x00\x00\x00\x01tree")] },
      ]),
    );
    const provider = new LabviewArtifactProvider();
    const result = await provider.inspect({ path });
    if (!result.ok) throw result.error;
    // The embedded program tree was inventoried but not decoded, so neither
    // heap can be called absent from the artifact.
    expect(result.value.block_diagram).toBe("unknown");
    expect(result.value.front_panel).toBe("unknown");
    expect(result.value.limitations.join(" ")).toContain(
      "unexamined content could still hold one",
    );
    await provider.close();
  });
});
