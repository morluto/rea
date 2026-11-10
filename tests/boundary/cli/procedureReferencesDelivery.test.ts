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
import { registerCoreNativeCommands } from "../../../src/cli/coreNativeCommands.js";
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
const procedure = {
  address: "0x1000",
  name: "selected",
  classification: null,
  body: { available: false as const, reason: "unavailable" },
};
const result = {
  procedure,
  direction: "incoming" as const,
  reference_kinds_available: false,
  references: [],
  unresolved_calls: [{ address: "0x1010", reason: "unknown target" }],
};

it.each([false, true])(
  "exports linked source Evidence or refuses missing closure (missing=%s)",
  async (missing) => {
    const root = await createTestTempDirectory("rea-procedure-references-cli-");
    const path = join(root, "fixture.hop"),
      output = join(root, "evidence.json");
    await writeFile(path, "synthetic analysis database");
    const history = createEvidence(undefined, identity, {
      operation: "health",
      parameters: {},
      result: "project history",
      ...(missing ? { evidenceLinks: ["ev_" + "a".repeat(64)] } : {}),
    });
    const provider: AnalysisProvider = {
      identity: () => identity,
      capabilities: () => [
        {
          provider: identity,
          operation: "procedure_references",
          available: true,
          reason: null,
          cachePolicy: "live",
          limitations: [],
          effects,
        },
      ],
      resolveAnalysisProfile: async () =>
        ok({ profile: createAnalysisProfile(identity, { fixture: true }) }),
      createClient: () => ({
        execute: async () =>
          ok(
            createAnalysisExecution(result, identity, {
              sourceEvidence: [history],
            }),
          ),
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
    const cli = Cli.create("procedure-references", { sync: false });
    registerCoreNativeCommands(
      cli,
      pino({ enabled: false }),
      (target, tool, args, options) =>
        runDirectAnalysis(dependencies, target, tool, args, options),
    );
    let stdout = "";
    await cli.serve(
      [
        "procedure-references",
        path,
        "selected",
        "--provider",
        "fixture",
        "--direction",
        "incoming",
        "--detail",
        "summary",
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
      const parent = bundle.records.find(
        (record) => record.operation === "procedure_references",
      );
      expect(response.summary.normalized_result).toMatchObject({
        parent_evidence_id: parent?.evidence_id,
        summary: {
          reference_count: 0,
          unresolved_call_count: 1,
          direction: "incoming",
        },
      });
      expect(parent?.evidence_links).toEqual([history.evidence_id]);
      expect(
        bundle.records.some(
          (record) => record.evidence_id === history.evidence_id,
        ),
      ).toBe(true);
    }
  },
);
