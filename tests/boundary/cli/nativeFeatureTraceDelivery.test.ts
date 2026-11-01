import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Cli } from "incur";
import pino from "pino";
import { expect, it } from "vitest";
import {
  createAnalysisExecution,
  type AnalysisProvider,
} from "../../../src/application/AnalysisProvider.js";
import { runDirectAnalysis } from "../../../src/application/DirectAnalysis.js";
import type { DirectAnalysisDependencies } from "../../../src/application/DirectAnalysisDependencies.js";
import { registerCoreBinaryCommands } from "../../../src/cli/coreBinaryCommands.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { ok } from "../../../src/domain/result.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const identity = { id: "fixture", name: "Fixture", version: "1" } as const;
const effects = {
  mutatesArtifact: false,
  launchesProcess: false,
  mayShowUi: false,
  mayAccessNetwork: false,
  mayWriteFilesystem: false,
  changesPermissions: false,
  requiresRoot: false,
};

it.each([
  { detail: "summary", missing: false },
  { detail: "complete", missing: false },
  { detail: "summary", missing: true },
])(
  "publishes $detail trace only when its source closure is available (missing=$missing)",
  async ({ detail, missing }) => {
    const root = await createTestTempDirectory("rea-native-trace-cli-source-");
    const path = join(root, "fixture.hop");
    const output = join(root, "evidence.json");
    await writeFile(path, "synthetic analysis database");
    const history = createEvidence(undefined, identity, {
      operation: "health",
      parameters: { facet: "historical-project-analysis-reports" },
      result: { origin: "caller-project" },
      confidence: "observed",
      ...(missing ? { evidenceLinks: ["ev_" + "a".repeat(64)] } : {}),
    });
    const provider: AnalysisProvider = {
      identity: () => identity,
      capabilities: () =>
        (
          [
            "search_strings",
            "search_procedures",
            "xrefs",
            "resolve_containing_procedure",
          ] as const
        ).map((operation) => ({
          provider: identity,
          operation,
          available: true,
          reason: null,
          cachePolicy: "live",
          limitations: [],
          effects,
        })),
      resolveAnalysisProfile: async () =>
        ok({ profile: createAnalysisProfile(identity, { fixture: true }) }),
      createClient: () => ({
        execute: async (operation) => {
          const value =
            operation === "search_procedures"
              ? [{ address: "0x1000", value: "goal" }]
              : operation === "xrefs"
                ? ["0x1010"]
                : operation === "resolve_containing_procedure"
                  ? {
                      query_address: "0x1010",
                      found: false,
                      procedure: null,
                      reason: "not_in_procedure",
                    }
                  : operation === "search_strings"
                    ? []
                    : null;
          return ok(
            createAnalysisExecution(value, identity, {
              sourceEvidence: [history],
            }),
          );
        },
        close: async () => ok(null),
      }),
    };
    const createSession = () => createTestBinarySession(provider);
    const dependencies: DirectAnalysisDependencies = {
      readConfiguration: () => parseConfig({}),
      createBinarySession: createSession,
      createNativeDispatchBinarySession: createSession,
      createArtifactBinarySession: createSession,
      createNativeBinarySession: createSession,
      createManagedBinarySession: createSession,
    };
    const cli = Cli.create("rea-native-trace-cli-source", { sync: false });
    registerCoreBinaryCommands(
      cli,
      pino({ enabled: false }),
      (target, tool, args, options) =>
        runDirectAnalysis(dependencies, target, tool, args, options),
      {},
    );
    let stdout = "";
    await cli.serve(
      [
        "trace",
        path,
        "goal",
        "--provider",
        "fixture",
        "--detail",
        detail,
        "--evidence_output",
        output,
        "--json",
      ],
      {
        env: {},
        stdout: (text) => {
          stdout += text;
        },
        exit: () => undefined,
      },
    );
    const response = JSON.parse(stdout);
    if (missing) {
      expect(response).toMatchObject({
        code: "evidence_integrity_mismatch",
        details: { reason: "missing", evidence_id: "ev_" + "a".repeat(64) },
      });
      await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      const bundle = parseEvidenceBundle(
        JSON.parse(await readFile(output, "utf8")),
      );
      const trace = bundle.records.find(
        (record) => record.operation === "trace_feature",
      );
      expect(
        detail === "summary"
          ? response.summary.normalized_result.parent_evidence_id
          : response.evidence_id,
      ).toBe(trace?.evidence_id);
      expect(trace?.evidence_links).toContain(history.evidence_id);
      expect(
        bundle.records.some(
          (record) => record.evidence_id === history.evidence_id,
        ),
      ).toBe(true);
    }
  },
);
