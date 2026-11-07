import { beforeAll, expect, it } from "vitest";
import { z } from "zod";

import { createCli } from "../../../src/cli.js";
import { CLI_COMMANDS } from "../../../src/cliCommandNames.js";
import { artifactComparisonInputSchema } from "../../../src/contracts/artifactComparisonContracts.js";
import {
  compareApplicationVersionsRequestSchema,
  compareJavaScriptExportShapesRequestSchema,
  compareSourceToBundleCliInputSchema,
  compareStaticObservedEndpointsFactsSchema,
  reconcileJavaScriptRuntimeRequestSchema,
  traceApplicationFeatureRequestSchema,
  traceJavaScriptSemanticsRequestSchema,
} from "../../../src/contracts/javascript/applicationWorkflowInputContracts.js";
import {
  getEvidenceBundleInputSchema,
  importEvidenceBundleInputSchema,
} from "../../../src/contracts/sessionToolSchemas.js";
import { reconstructionCoverageRequestSchema } from "../../../src/domain/reconstructionCoverageInput.js";
import { reconstructionObligationLedgerRequestSchema } from "../../../src/application/ReconstructionObligationLedgerRequest.js";
import { inspectAnalysisViewInputSchema } from "../../../src/domain/analysisView/analysisViewRequest.js";
import { browserScenarioSchema } from "../../../src/domain/browserScenario.js";
import { getEvidenceInputContract } from "../../../src/domain/evidenceInputContract.js";
import { electronActiveObservationInputSchema } from "../../../src/domain/javascript/electronActiveObservation.js";
import { applicationInventoryProjectionInputSchema } from "../../../src/domain/mobileApplicationGraphProjection.js";
import { managedApplicationGraphReferenceInputSchema } from "../../../src/domain/managed/managedApplicationGraph.js";
import { managedNativeVerificationRequestSchema } from "../../../src/domain/managed/managedNativeVerificationSchemas.js";
import { managedReconstructionImportRequestSchema } from "../../../src/domain/managed/managedReconstruction.js";
import { nativeCallObservationInputSchema } from "../../../src/domain/native/nativeCallObservation.js";
import {
  jsonInputArgument,
  jsonInputContentSchema,
} from "../../../src/cli/jsonInputArgument.js";
import { visitRegisteredCommands } from "../../../src/cli/visitRegisteredCommands.js";
import type { CliInstance } from "../../../src/cli/types.js";

const frame = (schema: z.ZodType): z.ZodType =>
  getEvidenceInputContract(schema).frameSchema;

const inspectEvidenceBundleCliInputSchema =
  getEvidenceBundleInputSchema.safeExtend({
    path: importEvidenceBundleInputSchema.shape.path,
  });
const inventoryDocumentSchema = frame(
  applicationInventoryProjectionInputSchema,
);

/** Every positional JSON document and the schema its handler parses. */
const documents = [
  {
    command: CLI_COMMANDS.traceApplicationFeature,
    schema: frame(traceApplicationFeatureRequestSchema),
  },
  {
    command: CLI_COMMANDS.traceJavaScriptSemantics,
    schema: frame(traceJavaScriptSemanticsRequestSchema),
  },
  {
    command: CLI_COMMANDS.compareApplicationVersions,
    schema: frame(compareApplicationVersionsRequestSchema),
  },
  {
    command: CLI_COMMANDS.compareStaticAndObservedEndpoints,
    schema: frame(compareStaticObservedEndpointsFactsSchema),
  },
  {
    command: CLI_COMMANDS.compareSourceToBundle,
    schema: frame(compareSourceToBundleCliInputSchema),
  },
  {
    command: CLI_COMMANDS.compareJavaScriptExportShapes,
    schema: frame(compareJavaScriptExportShapesRequestSchema),
  },
  {
    command: CLI_COMMANDS.buildReconstructionObligationLedger,
    schema: reconstructionObligationLedgerRequestSchema,
  },
  {
    command: CLI_COMMANDS.evaluateReconstructionCoverage,
    schema: reconstructionCoverageRequestSchema,
  },
  {
    command: CLI_COMMANDS.projectAndroidApplicationGraph,
    schema: inventoryDocumentSchema,
  },
  {
    command: CLI_COMMANDS.projectAppleApplicationGraph,
    schema: inventoryDocumentSchema,
  },
  {
    command: CLI_COMMANDS.projectHarmonyApplicationGraph,
    schema: inventoryDocumentSchema,
  },
  {
    command: CLI_COMMANDS.inspectEvidenceBundle,
    schema: inspectEvidenceBundleCliInputSchema,
  },
  {
    command: CLI_COMMANDS.inspectAnalysisView,
    schema: inspectAnalysisViewInputSchema,
  },
  {
    command: CLI_COMMANDS.captureElectronScenario,
    schema: electronActiveObservationInputSchema,
  },
  {
    command: CLI_COMMANDS.reconcileJavaScriptRuntime,
    schema: frame(reconcileJavaScriptRuntimeRequestSchema),
  },
  {
    command: CLI_COMMANDS.observeNativeCalls,
    schema: nativeCallObservationInputSchema,
  },
  {
    command: CLI_COMMANDS.importManagedReconstruction,
    schema: frame(managedReconstructionImportRequestSchema),
  },
  {
    command: CLI_COMMANDS.verifyManagedNativeBoundaries,
    schema: frame(managedNativeVerificationRequestSchema),
  },
  {
    command: CLI_COMMANDS.projectManagedApplicationGraph,
    schema: frame(managedApplicationGraphReferenceInputSchema),
  },
  {
    command: CLI_COMMANDS.compareArtifacts,
    schema: artifactComparisonInputSchema,
  },
  {
    command: CLI_COMMANDS.captureBrowserScenario,
    schema: browserScenarioSchema,
  },
  {
    command: CLI_COMMANDS.validateBrowserScenario,
    schema: browserScenarioSchema,
  },
] as const;

interface InputJsonSchema {
  readonly type?: unknown;
  readonly description?: unknown;
  readonly contentMediaType?: unknown;
  readonly contentSchema?: {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
  };
}

const jsonInputCommands = (cli: CliInstance): string[] => {
  const names: string[] = [];
  visitRegisteredCommands(cli, (command, path) => {
    if (
      command.args instanceof z.ZodObject &&
      Object.hasOwn(command.args.shape, "inputJson")
    )
      names.push(path);
  });
  return names;
};

let cli: ReturnType<typeof createCli>;

beforeAll(() => {
  cli = createCli({});
});

const serve = async (argv: readonly string[]) => {
  let stdout = "";
  let exitCode = 0;
  await cli.serve([...argv], {
    env: {},
    exit: (code) => {
      exitCode = code;
    },
    stdout: (text) => {
      stdout += text;
    },
  });
  return { stdout, exitCode };
};

const advertisedInput = (stdout: string): InputJsonSchema => {
  const document = JSON.parse(stdout) as {
    args?: {
      properties?: { inputJson?: InputJsonSchema };
      required?: readonly string[];
    };
  };
  expect(document.args?.required).toContain("inputJson");
  const inputJson = document.args?.properties?.inputJson;
  expect(inputJson).toMatchObject({
    type: "string",
    contentMediaType: "application/json",
  });
  expect(typeof inputJson?.description).toBe("string");
  return inputJson as InputJsonSchema;
};

it("advertises the parsed document for every JSON-input command", async () => {
  expect(jsonInputCommands(cli).sort()).toEqual(
    documents.map(({ command }) => command).sort(),
  );
  for (const { command, schema } of documents) {
    const served = await serve([command, "--schema", "--json"]);
    expect(served.exitCode, served.stdout).toBe(0);
    const inputJson = advertisedInput(served.stdout);
    expect(inputJson.contentSchema, command).toEqual(
      jsonInputContentSchema(schema),
    );
    expect(inputJson.contentSchema, command).not.toEqual({});
  }
});

it("names the feature-trace, semantic-query, and browser-scenario fields", async () => {
  const trace = advertisedInput(
    (await serve([CLI_COMMANDS.traceApplicationFeature, "--schema", "--json"]))
      .stdout,
  );
  expect(trace.description).toBe("Inline workflow JSON or JSON file path");
  expect(Object.keys(trace.contentSchema?.properties ?? {})).toEqual([
    "native_observations",
    "seed",
    "semantic_page",
    "direction",
    "application",
  ]);
  expect(trace.contentSchema?.required).toEqual(["seed", "application"]);

  const semantic = advertisedInput(
    (await serve([CLI_COMMANDS.traceJavaScriptSemantics, "--schema", "--json"]))
      .stdout,
  );
  expect(Object.keys(semantic.contentSchema?.properties ?? {})).toEqual([
    "application",
    "query",
  ]);
  expect(semantic.contentSchema?.required).toEqual(["application", "query"]);

  const browser = advertisedInput(
    (await serve([CLI_COMMANDS.captureBrowserScenario, "--schema", "--json"]))
      .stdout,
  );
  expect(browser.description).toBe(
    "Inline browser scenario JSON, JSON file path, or '-' for stdin",
  );
  expect(browser.contentSchema?.properties).toEqual(
    expect.objectContaining({
      browser: expect.any(Object),
      start_url: expect.any(Object),
      actions: expect.any(Object),
    }),
  );
  expect(browser.contentSchema?.required).toEqual(
    expect.arrayContaining(["browser", "start_url", "actions"]),
  );
});

it("keeps unknown envelope fields permissive and named fields constrained", async () => {
  const coverage = advertisedInput(
    (
      await serve([
        CLI_COMMANDS.evaluateReconstructionCoverage,
        "--schema",
        "--json",
      ])
    ).stdout,
  );
  expect(coverage.contentSchema?.properties?.coverage).toEqual({});
  expect(coverage.contentSchema?.properties?.boundary_id).toMatchObject({
    type: "string",
    minLength: 1,
  });
  expect(coverage.contentSchema?.required).toEqual(["coverage", "boundary_id"]);

  const ledger = advertisedInput(
    (
      await serve([
        CLI_COMMANDS.buildReconstructionObligationLedger,
        "--schema",
        "--json",
      ])
    ).stdout,
  );
  expect(ledger.contentSchema?.properties?.evidence_bundle).toEqual({});
  expect(ledger.contentSchema?.required).toEqual(
    expect.arrayContaining([
      "evidence_bundle",
      "reviewed_obligations",
      "manifest",
    ]),
  );
});

it("prints the nested document in the default schema format", async () => {
  const served = await serve([
    CLI_COMMANDS.traceApplicationFeature,
    "--schema",
  ]);
  expect(served.exitCode, served.stdout).toBe(0);
  expect(served.stdout).toContain("contentMediaType: application/json");
  expect(served.stdout).toContain("contentSchema:");
  expect(served.stdout).toContain("seed:");
  expect(served.stdout).toContain("application:");
});

it("uses an empty schema only for unknown or any documents", () => {
  expect(jsonInputContentSchema(z.unknown())).toEqual({});
  expect(jsonInputContentSchema(z.any())).toEqual({});
  expect(jsonInputContentSchema(z.unknown().nonoptional())).toEqual({});

  const custom = z.custom<string>();
  expect(jsonInputContentSchema(custom)).toBeUndefined();
  const omitted = z.toJSONSchema(jsonInputArgument("payload", custom));
  expect(omitted).toMatchObject({
    type: "string",
    description: "payload",
    contentMediaType: "application/json",
  });
  expect(omitted).not.toHaveProperty("contentSchema");

  const exploding = z.object({ value: z.string() });
  exploding._zod.toJSONSchema = () => {
    throw new Error("unconvertible");
  };
  expect(jsonInputContentSchema(exploding)).toBeUndefined();
  expect(() =>
    z.toJSONSchema(jsonInputArgument("payload", exploding)),
  ).not.toThrow();

  const query = z.toJSONSchema(
    jsonInputArgument(
      "Inline workflow JSON or JSON file path",
      z.strictObject({ query: z.string() }),
    ),
  );
  expect(query).toMatchObject({
    type: "string",
    description: "Inline workflow JSON or JSON file path",
    contentMediaType: "application/json",
    contentSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  });
});
