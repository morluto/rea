import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";
import { readEvidenceBundle } from "../../../src/application/EvidenceBundleFiles.js";
import { contractNamed } from "../../../src/cli/contractCliDescription.js";
import { ANALYSIS_VIEW_TOOL_CONTRACTS } from "../../../src/contracts/analysisViewToolContracts.js";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisViewResult.js";
import { digestCanonicalValue } from "../../../src/domain/canonicalDigest.js";
import { evidenceSchema } from "../../../src/domain/evidence.js";
import {
  buildStringTable,
  elfDebugLineImage,
  lineProgram,
  lneEndSequence,
  lneSetAddress,
  lnsAdvanceLine,
  lnsAdvancePc,
  lnsCopy,
  lnsSetFile,
} from "../../../src/native/dwarf/DwarfLines.fixture.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const linesContract = contractNamed(
  BINARY_DIAGNOSTICS_TOOL_CONTRACTS,
  "inspect_dwarf_lines",
);
const viewContract = contractNamed(
  ANALYSIS_VIEW_TOOL_CONTRACTS,
  "inspect_analysis_view",
);

cliTest(
  "queries retained DWARF line programs through CLI and actual stdio MCP after the source is deleted",
  { timeout: 60_000 },
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-dwarf-lines-views-");
    const path = join(root, "program");
    const strings = buildStringTable(["/src", "alpha.c", "beta.c"]);
    const line = lineProgram({
      version: 5,
      addressSize: 8,
      v5Directories: [{ form: 0x1f, lineStrp: strings.offsets[0]! }],
      v5Files: [
        { path: { form: 0x1f, lineStrp: strings.offsets[1]! }, dirIndex: 0 },
        { path: { form: 0x1f, lineStrp: strings.offsets[2]! }, dirIndex: 0 },
      ],
      opcodes: Buffer.concat([
        lneSetAddress(0x1000n, 8, true),
        lnsSetFile(0),
        lnsAdvanceLine(9),
        lnsCopy(),
        lnsSetFile(1),
        lnsAdvancePc(8),
        lnsAdvanceLine(5),
        lnsCopy(),
        lnsAdvancePc(8),
        lneEndSequence(),
      ]),
    });
    await writeFile(
      path,
      elfDebugLineImage({ line, lineStr: strings.table }, { type: 2 }),
    );
    const run = cli.run.bind(cli);
    const complete = await run({
      arguments: [
        "inspect-dwarf-lines",
        path,
        "--addresses",
        "0x1008",
        "--json",
      ],
    });
    expect(complete.exitCode, complete.stderr).toBe(0);
    const parent = linesContract.outputSchema.parse(complete.json);
    const bundle = join(root, "complete.bundle.json");
    const summarized = await run({
      arguments: [
        "inspect-dwarf-lines",
        path,
        "--addresses",
        "0x1008",
        "--detail",
        "summary",
        "--evidence_output",
        bundle,
        "--json",
      ],
    });
    expect(summarized.exitCode, summarized.stderr).toBe(0);
    const delivered = z
      .object({ summary: evidenceSchema })
      .parse(summarized.json).summary;
    expect(delivered.operation).toBe("inspect_analysis_view");
    expect(delivered.normalized_result).toMatchObject({
      parent_evidence_id: parent.evidence_id,
      summary: {
        program_count: 1,
        file_count: 2,
        row_count: 3,
        address_match_count: 1,
        coverage: { status: "complete" },
      },
    });
    const loaded = await readEvidenceBundle(bundle);
    if (!loaded.ok) throw loaded.error;
    expect(loaded.value.records).toEqual([parent]);

    const call =
      cli.sharedMcpCall === undefined
        ? (await connectLocalToolsMcp()).call
        : await cli.sharedMcpCall();
    const response = await call("inspect_dwarf_lines", {
      path,
      addresses: ["0x1008"],
      detail: "summary",
    });
    expect(response.isError).not.toBe(true);
    expect(
      linesContract.outputSchema.parse(response.structuredContent)
        .normalized_result,
    ).toEqual(delivered.normalized_result);

    await rm(path);
    const source = {
      kind: "retained-evidence",
      evidence_id: parent.evidence_id,
    };
    const request = {
      source,
      view: {
        kind: "dwarf-lines",
        collection: "files",
        name: "beta.c",
        offset: 0,
        limit: 10,
      },
    };
    const viewed = await call("inspect_analysis_view", request);
    expect(viewed.isError).not.toBe(true);
    const page = viewContract.outputSchema.parse(viewed.structuredContent);
    expect(page.evidence_links).toContain(parent.evidence_id);
    expect(page.normalized_result).toMatchObject({
      kind: "dwarf-lines",
      items: [{ source_index: 1, program_index: 0, index: 1 }],
      coverage: { examined: 1, total: 1, next_offset: null, exhausted: true },
    });

    const offline = await run({
      arguments: [
        "inspect-analysis-view",
        JSON.stringify(request),
        "--evidence-bundle",
        bundle,
        "--json",
      ],
    });
    expect(offline.exitCode, offline.stderr).toBe(0);
    expect(viewContract.outputSchema.parse(offline.json)).toEqual(page);

    const projected = await call("inspect_analysis_view", {
      source,
      view: {
        kind: "dwarf-lines",
        collection: "rows",
        file: "/src/beta.c",
        fields: ["address", "line"],
        offset: 0,
        limit: 1,
      },
    });
    expect(projected.isError).not.toBe(true);
    const projectedView = analysisViewResultSchema.parse(
      viewContract.outputSchema.parse(projected.structuredContent)
        .normalized_result,
    );
    expect(projectedView).toMatchObject({
      items: [{ source_index: 1, address: "0x1008", line: 15 }],
    });
    const { view_digest, ...content } = projectedView;
    expect(view_digest).toBe(digestCanonicalValue(content, "Analysis view"));
  },
);

cliTest(
  "refuses CLI summary without a durable Evidence destination before reading",
  async ({ cli }) => {
    const result = await cli.run({
      arguments: [
        "inspect-dwarf-lines",
        "/rea-nonexistent/program",
        "--detail",
        "summary",
        "--json",
      ],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      details: { issues: [{ path: ["evidence_output"] }] },
    });
  },
);
