import { EVIDENCE_FORMAT_REVISION } from "../../../src/domain/evidenceFormat.js";
import { beforeAll, expect, it } from "vitest";
import { serveInProcessCli } from "../../support/cli/serveInProcessCli.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import { z } from "zod";

import { createCli } from "../../../src/cli.js";
import {
  CLI_COMMANDS,
  cliCommandFor,
} from "../../../src/contracts/cliCommandNames.js";
import { artifactComparisonInputSchema } from "../../../src/contracts/artifactComparisonContracts.js";
import {
  compareApplicationVersionsRequestSchema,
  compareJavaScriptExportShapesRequestSchema,
  compareSourceToBundleRequestSchema,
  compareStaticObservedEndpointsFactsSchema,
  reconcileJavaScriptRuntimeRequestSchema,
  traceApplicationFeatureRequestSchema,
  traceJavaScriptSemanticsRequestSchema,
} from "../../../src/contracts/javascript/applicationWorkflowInputContracts.js";
import {
  getEvidenceBundleInputSchema,
  importEvidenceBundleInputSchema,
} from "../../../src/contracts/sessionToolSchemas.js";
import { reconstructionCoverageEvaluationInputSchema } from "../../../src/domain/reconstructionCoverageInput.js";
import { reconstructionObligationLedgerInputSchema } from "../../../src/domain/reconstructionObligationLedgerSchemas.js";
import { inspectAnalysisViewInputSchema } from "../../../src/domain/analysisView/analysisViewRequest.js";
import { browserScenarioSchema } from "../../../src/domain/browserScenario.js";
import { getEvidenceInputContract } from "../../../src/domain/evidenceInputContract.js";
import { electronActiveObservationInputSchema } from "../../../src/domain/javascript/electronActiveObservation.js";
import { applicationInventoryProjectionInputSchema } from "../../../src/domain/mobileApplicationGraphProjection.js";
import { managedApplicationGraphReferenceInputSchema } from "../../../src/domain/managed/managedApplicationGraph.js";
import { managedNativeVerificationRequestSchema } from "../../../src/domain/managed/managedNativeVerificationSchemas.js";
import { managedReconstructionImportRequestSchema } from "../../../src/domain/managed/managedReconstruction.js";
import { nativeCallObservationInputSchema } from "../../../src/domain/native/nativeCallObservation.js";
import { matchNativeFunctionsInputSchema } from "../../../src/contracts/native/functionMatchingContracts.js";
import { COMPARE_WASM_INTERFACES_CONTRACT } from "../../../src/contracts/wasm/wasmComparisonContracts.js";
import {
  jsonInputArgument,
  jsonInputContentSchema,
} from "../../../src/cli/jsonInputArgument.js";
import { cliJsonCallerPathSchema } from "../../../src/cli/cliJsonInput.js";
import { cliCommands } from "../../../src/cli/commandRegistry.js";
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
const documents: readonly {
  readonly command: string;
  readonly schema: z.ZodType;
  /** Fields the CLI resolves against the working directory before parsing. */
  readonly callerPaths?: readonly (readonly string[])[];
}[] = [
  {
    command: cliCommandFor("trace_application_feature"),
    schema: frame(traceApplicationFeatureRequestSchema),
  },
  {
    command: cliCommandFor("trace_javascript_semantics"),
    schema: frame(traceJavaScriptSemanticsRequestSchema),
  },
  {
    command: cliCommandFor("compare_application_versions"),
    schema: frame(compareApplicationVersionsRequestSchema),
  },
  {
    command: cliCommandFor("compare_static_and_observed_endpoints"),
    schema: frame(compareStaticObservedEndpointsFactsSchema),
  },
  {
    command: cliCommandFor("compare_source_to_bundle"),
    schema: frame(compareSourceToBundleRequestSchema.omit({ view: true })),
    callerPaths: [["reference", "path"]],
  },
  {
    command: cliCommandFor("compare_javascript_export_shapes"),
    schema: frame(compareJavaScriptExportShapesRequestSchema),
  },
  {
    command: cliCommandFor("build_reconstruction_obligation_ledger"),
    schema: reconstructionObligationLedgerInputSchema,
  },
  {
    command: cliCommandFor("evaluate_reconstruction_coverage"),
    schema: reconstructionCoverageEvaluationInputSchema,
  },
  {
    command: cliCommandFor("project_android_application_graph"),
    schema: inventoryDocumentSchema,
  },
  {
    command: cliCommandFor("project_apple_application_graph"),
    schema: inventoryDocumentSchema,
  },
  {
    command: cliCommandFor("project_harmony_application_graph"),
    schema: inventoryDocumentSchema,
  },
  {
    command: CLI_COMMANDS.inspectEvidenceBundle,
    schema: inspectEvidenceBundleCliInputSchema,
  },
  {
    command: cliCommandFor("inspect_analysis_view"),
    schema: inspectAnalysisViewInputSchema,
    callerPaths: [
      ["source", "path"],
      ["view", "artifact_path"],
    ],
  },
  {
    command: cliCommandFor("capture_electron_scenario"),
    schema: electronActiveObservationInputSchema,
    callerPaths: [
      ["executable_path"],
      ["application_path"],
      ["application_root"],
    ],
  },
  {
    command: cliCommandFor("reconcile_javascript_runtime"),
    schema: frame(reconcileJavaScriptRuntimeRequestSchema),
  },
  {
    command: cliCommandFor("observe_native_calls"),
    schema: nativeCallObservationInputSchema,
  },
  {
    command: cliCommandFor("import_managed_reconstruction"),
    schema: frame(managedReconstructionImportRequestSchema),
  },
  {
    command: cliCommandFor("verify_managed_native_boundaries"),
    schema: frame(managedNativeVerificationRequestSchema),
  },
  {
    command: cliCommandFor("project_managed_application_graph"),
    schema: frame(managedApplicationGraphReferenceInputSchema),
  },
  {
    command: cliCommandFor("compare_artifacts"),
    schema: artifactComparisonInputSchema,
    callerPaths: [
      ["left", "path"],
      ["right", "path"],
    ],
  },
  {
    command: cliCommandFor("compare_wasm_interfaces"),
    schema: frame(COMPARE_WASM_INTERFACES_CONTRACT.inputSchema),
  },
  {
    command: cliCommandFor("match_native_functions"),
    schema: frame(matchNativeFunctionsInputSchema),
  },
  {
    command: cliCommandFor("capture_browser_scenario"),
    schema: browserScenarioSchema,
    callerPaths: [["browser", "executable_path"]],
  },
  {
    command: CLI_COMMANDS.validateBrowserScenario,
    schema: browserScenarioSchema,
    callerPaths: [["browser", "executable_path"]],
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
  cliCommands(cli).forEach(({ definition: command, name: path }) => {
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

type JsonSchemaNode = Record<string, unknown>;

const cliCallerPath = jsonInputContentSchema(
  cliJsonCallerPathSchema,
) as JsonSchemaNode;

/** Expect a caller path as the CLI admits it: any nonempty local spelling. */
const admitRelativePath = (
  schema: JsonSchemaNode,
  path: readonly string[],
): JsonSchemaNode => {
  const [head, ...tail] = path;
  if (head === undefined) {
    const { allOf: _patterns, pattern: _pattern, ...rest } = schema;
    return { ...rest, ...cliCallerPath };
  }
  const branches = (["anyOf", "oneOf"] as const).flatMap((keyword) =>
    Array.isArray(schema[keyword])
      ? [
          [
            keyword,
            (schema[keyword] as JsonSchemaNode[]).map((branch) =>
              admitRelativePath(branch, path),
            ),
          ] as const,
        ]
      : [],
  );
  const properties = schema.properties as
    | Record<string, JsonSchemaNode>
    | undefined;
  return {
    ...schema,
    ...Object.fromEntries(branches),
    ...(properties?.[head] === undefined
      ? {}
      : {
          properties: {
            ...properties,
            [head]: admitRelativePath(properties[head], tail),
          },
        }),
  };
};

it("advertises the parsed document for every JSON-input command", async () => {
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  expect(jsonInputCommands(cli).sort()).toEqual(
    documents.map(({ command }) => command).sort(),
  );
  for (const { command, schema, callerPaths = [] } of documents) {
    const served = await serveInProcessCli(cli, [
      command,
      "--schema",
      "--json",
    ]);
    expect(served.exitCode, served.stdout).toBe(0);
    const inputJson = advertisedInput(served.stdout);
    expect(inputJson.contentSchema, command).toBeDefined();
    expect(inputJson.contentSchema, command).toEqual(
      callerPaths.reduce(
        admitRelativePath,
        jsonInputContentSchema(schema) as JsonSchemaNode,
      ),
    );
    expect(inputJson.contentSchema, command).not.toEqual({});
    expect(
      () => ajv.compile(inputJson.contentSchema as AnySchema),
      command,
    ).not.toThrow();
  }
});

it("advertises caller paths as local spellings the CLI resolves, not URLs", async () => {
  const input = advertisedInput(
    (
      await serveInProcessCli(cli, [
        cliCommandFor("compare_source_to_bundle"),
        "--schema",
        "--json",
      ])
    ).stdout,
  );
  const validate = new Ajv2020({
    strict: false,
    validateFormats: false,
  }).compile(input.contentSchema as AnySchema);
  const document = (path: string) => ({
    reference: { kind: "file", path },
    application: {},
  });
  for (const path of [
    "ref.json",
    "./file:ref.json",
    "C:\\ref.json",
    " ref.json ",
    "folder/ ",
  ])
    expect(validate(document(path)), path).toBe(true);
  for (const path of [
    "file:ref.json",
    "FILE:ref.json",
    "https://x/ref.json",
    "",
    " ",
    "\t\r\n",
    "\u00a0",
    "\u2003",
    "\ufeff",
  ])
    expect(validate(document(path)), path).toBe(false);
});

it("advertises coverage input that admits a complete document and checks its boundary", async () => {
  const input = advertisedInput(
    (
      await serveInProcessCli(cli, [
        cliCommandFor("evaluate_reconstruction_coverage"),
        "--schema",
        "--json",
      ])
    ).stdout,
  );
  const validate = new Ajv2020({
    strict: false,
    validateFormats: false,
  }).compile(input.contentSchema as AnySchema);
  const evidence_bundle = {
    evidence_format: EVIDENCE_FORMAT_REVISION,
    artifacts: [],
    providers: [],
    environments: [],
    scenarios: [],
    captures: [],
    unknowns: [],
    records: [],
  };
  const coverage = {
    evidence_bundle,
    artifacts: [],
    surfaces: [],
    owners: [],
    claims: [],
    verifier_contracts: [],
    verifier_results: [],
    residual_unknown_ids: [],
    contradictions: [],
    package_proofs: [],
    boundaries: [],
  };
  const accepted = { coverage, boundary_id: "main" };
  const { boundaries: _boundaries, ...withoutBoundaries } = coverage;
  const rejected = [
    { coverage, boundary_id: "" },
    { coverage, boundary_id: "main section" },
    { ...accepted, coverage: withoutBoundaries },
    { coverage },
    { coverage, boundary_id: "main", extra: true },
    { coverage: { arbitrary: true }, boundary_id: "main" },
    {
      coverage: { ...coverage, evidence_bundle: { records: [] } },
      boundary_id: "main",
    },
  ];
  const contract = reconstructionCoverageEvaluationInputSchema;
  expect(contract.safeParse(accepted).success).toBe(true);
  expect(validate(accepted)).toBe(true);
  for (const document of rejected) {
    expect(contract.safeParse(document).success).toBe(false);
    expect(validate(document)).toBe(false);
  }
});

it("names the feature-trace, semantic-query, and browser-scenario fields", async () => {
  const trace = advertisedInput(
    (
      await serveInProcessCli(cli, [
        cliCommandFor("trace_application_feature"),
        "--schema",
        "--json",
      ])
    ).stdout,
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
    (
      await serveInProcessCli(cli, [
        cliCommandFor("trace_javascript_semantics"),
        "--schema",
        "--json",
      ])
    ).stdout,
  );
  expect(Object.keys(semantic.contentSchema?.properties ?? {})).toEqual([
    "application",
    "query",
  ]);
  expect(semantic.contentSchema?.required).toEqual(["application", "query"]);

  const browser = advertisedInput(
    (
      await serveInProcessCli(cli, [
        cliCommandFor("capture_browser_scenario"),
        "--schema",
        "--json",
      ])
    ).stdout,
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

it("advertises the reconstruction obligation ledger its reader admits", async () => {
  const ledger = advertisedInput(
    (
      await serveInProcessCli(cli, [
        cliCommandFor("build_reconstruction_obligation_ledger"),
        "--schema",
        "--json",
      ])
    ).stdout,
  );
  expect(ledger.contentSchema?.properties?.evidence_bundle).toMatchObject({
    type: "object",
    required: expect.arrayContaining(["artifacts", "records"]),
  });
  expect(ledger.contentSchema?.required).toEqual(
    expect.arrayContaining([
      "evidence_bundle",
      "reviewed_obligations",
      "manifest",
    ]),
  );
});

it("prints the nested document in the default schema format", async () => {
  const served = await serveInProcessCli(cli, [
    cliCommandFor("trace_application_feature"),
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
