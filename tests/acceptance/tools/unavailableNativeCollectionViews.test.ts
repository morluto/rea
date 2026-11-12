import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import {
  nativeLoadImageObservationFixture,
  nativeRawLoadImageFixture,
} from "../../fixtures/nativeLoadImage.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "distinguishes unavailable native collections from empty selections through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-unavailable-native-view-");
    const provider = {
      id: "fixture",
      name: "Retained native fixture",
      version: "1",
    };
    const load = (result: unknown) =>
      createEvidence(undefined, provider, {
        operation: "inspect_native_load_image",
        parameters: {},
        result,
        limitations: [
          "Synthetic retained Evidence; no native provider was run.",
        ],
      });
    const unsupported = load({
      status: "unsupported",
      reason: "Independent ELF load verification was not recorded.",
      observations: {
        ...nativeLoadImageObservationFixture(),
        executable_format: "Executable and Linking Format (ELF)",
      },
      limitations: [],
    });
    const raw = load(nativeRawLoadImageFixture());
    const primitive = createEvidence(undefined, provider, {
      operation: "procedure_callees",
      parameters: {},
      result: [],
    });
    const graph = createEvidence(undefined, provider, {
      operation: "get_call_graph",
      parameters: {},
      result: { graph: {}, limitations: [] },
    });
    const unavailable = {
      status: "unavailable",
      examined: 0,
      total: null,
      next_offset: null,
      exhausted: false,
    };
    const empty = (total: number) => ({
      status: "empty",
      examined: 0,
      total,
      next_offset: null,
      exhausted: true,
    });
    const cases = [
      {
        label: "checks-unrecorded",
        evidence: unsupported,
        view: { kind: "native-load-image", collection: "checks" },
        rows: null,
        coverage: unavailable,
      },
      {
        label: "sections-unrecorded-despite-empty-selection",
        evidence: unsupported,
        view: {
          kind: "native-load-image",
          collection: "sections",
          offset: 5,
          indices: [],
        },
        rows: null,
        coverage: unavailable,
      },
      {
        label: "checks-recorded-empty",
        evidence: raw,
        view: { kind: "native-load-image", collection: "checks" },
        rows: [],
        coverage: empty(0),
      },
      {
        label: "mappings-empty-selection",
        evidence: unsupported,
        view: {
          kind: "native-load-image",
          collection: "mappings",
          indices: [],
        },
        rows: [],
        coverage: empty(0),
      },
      {
        label: "mappings-past-end",
        evidence: unsupported,
        view: { kind: "native-load-image", collection: "mappings", offset: 5 },
        rows: [],
        coverage: empty(1),
      },
      {
        label: "primitive-result-limitations-inapplicable",
        evidence: primitive,
        view: { kind: "native-context", facet: "result-limitations" },
        rows: null,
        coverage: unavailable,
      },
      {
        label: "graph-result-limitations-recorded-empty",
        evidence: graph,
        view: { kind: "native-context", facet: "result-limitations" },
        rows: [],
        coverage: empty(0),
      },
    ];
    const call = await cli.sharedMcpCall!();
    const run = cli.sharedCliRun!.bind(cli);
    for (const test of cases) {
      const request = {
        source: { kind: "inline", evidence: test.evidence },
        view: test.view,
      };
      const path = join(root, `${test.label}.json`);
      await writeFile(path, JSON.stringify(request));
      const output = await run({
        arguments: ["inspect-analysis-view", path, "--json"],
      });
      expect(output.exitCode, output.stderr || output.stdout).toBe(0);
      const page = analysisViewResultSchema.parse(
        parseEvidence(output.json).normalized_result,
      );
      const response = await call("inspect_analysis_view", request);
      expect(response.isError).not.toBe(true);
      expect(
        parseEvidence(response.structuredContent).normalized_result,
      ).toEqual(page);
      expect(page, test.label).toMatchObject({
        parent_evidence_id: test.evidence.evidence_id,
        items: { rows: test.rows },
        coverage: test.coverage,
      });
    }
  },
);
