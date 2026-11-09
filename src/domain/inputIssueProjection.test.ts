import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  analysisInputErrorFromIssues,
  analysisOperationInputErrorFromIssues,
  projectInputIssues,
  projectInputIssuesBounded,
  projectInputIssueGroupsWithinBudget,
} from "./inputIssueProjection.js";
import { projectAnalysisError } from "./analysisErrorProjection.js";
import { processScenarioSchema } from "./process/processScenario.js";
import { applicationFeatureSeedSchema } from "./javascript/javascriptFeatureTraceSchemas.js";
import { updateAnalysisSettingsInputSchema } from "../contracts/analysisSettingsContracts.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../contracts/officialToolContracts.js";
import { APPLICATION_TOOL_CONTRACTS } from "../contracts/applicationToolContracts.js";
import { ENHANCED_TOOL_CONTRACTS } from "../contracts/enhancedToolContracts.js";

const projectFlattenedIssueGroups = (
  ...args: Parameters<typeof projectInputIssueGroupsWithinBudget>
) => projectInputIssueGroupsWithinBudget(...args)?.flat();

const officialContract = (
  name: (typeof OFFICIAL_TOOL_CONTRACTS)[number]["name"],
) => {
  const contract = OFFICIAL_TOOL_CONTRACTS.find((c) => c.name === name);
  if (contract === undefined)
    throw new Error(`Missing official contract: ${name}`);
  return contract;
};

const applicationContract = (
  name: (typeof APPLICATION_TOOL_CONTRACTS)[number]["name"],
) => {
  const contract = APPLICATION_TOOL_CONTRACTS.find((c) => c.name === name);
  if (contract === undefined)
    throw new Error(`Missing application contract: ${name}`);
  return contract;
};

const enhancedContract = (
  name: (typeof ENHANCED_TOOL_CONTRACTS)[number]["name"],
) => {
  const contract = ENHANCED_TOOL_CONTRACTS.find((c) => c.name === name);
  if (contract === undefined)
    throw new Error(`Missing enhanced contract: ${name}`);
  return contract;
};

describe("input issue projection", () => {
  it("builds application input errors with projected and semantic issues", () => {
    const schema = z.object({ count: z.number().int() });
    const input = { count: "invalid" };
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error("expected invalid input");
    const cause = parsed.error;
    const error = analysisInputErrorFromIssues(
      "inspect_fixture",
      parsed.error.issues,
      input,
      {
        cause,
        userMessage: "Supply an integer count.",
        additionalIssues: [
          { path: ["count"], reason: "out_of_range", minimum: 0 },
        ],
      },
    );

    expect(error.cause).toBe(cause);
    expect(error.userMessage).toBe("Supply an integer count.");
    expect(error.issues).toEqual([
      { path: ["count"], reason: "invalid_type", expected: "number" },
      { path: ["count"], reason: "out_of_range", minimum: 0 },
    ]);
  });

  it("preserves static regex guidance without echoing the rejected value", () => {
    const schema = z.object({
      value: z.string().regex(/^[^\0]*$/u, "Values cannot contain NUL"),
    });
    const input = { value: "private\0value" };
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error("expected invalid input");

    expect(projectInputIssues(parsed.error.issues, input)).toEqual([
      {
        path: ["value"],
        reason: "invalid_format",
        expected: "regex",
        message: "Values cannot contain NUL",
      },
    ]);
  });

  it("projects reserved process environment key constraints at the key path", () => {
    const input = {
      executable: "/usr/bin/true",
      environment: { REA_PROCESS_RUN_ID: "caller-value" },
    };
    const parsed = processScenarioSchema.safeParse(input);
    if (parsed.success) throw new Error("expected invalid input");

    expect(projectInputIssues(parsed.error.issues, input)).toEqual([
      {
        path: ["environment", "REA_PROCESS_RUN_ID"],
        reason: "invalid_format",
        expected: "regex",
        message: "REA_PROCESS_RUN_ID is reserved by the process adapter",
      },
    ]);
  });

  it("preserves schema-authored custom correction guidance", () => {
    const schema = z
      .object({ left: z.string().optional(), right: z.string().optional() })
      .superRefine((value, context) => {
        if (value.left === undefined && value.right === undefined)
          context.addIssue({
            code: "custom",
            path: [],
            message: "Supply either left or right",
          });
      });
    const parsed = schema.safeParse({});
    if (parsed.success) throw new Error("expected invalid input");

    expect(projectInputIssues(parsed.error.issues, {})).toEqual([
      {
        path: [],
        reason: "invalid_value",
        message: "Supply either left or right",
      },
    ]);
  });

  it("reports union branch issues at the union's path once", () => {
    const schema = z.object({
      seed: z.union([
        z.object({ value: z.string().min(1) }),
        z.object({ value: z.literal(""), match: z.literal("exact") }),
      ]),
    });
    const missing = schema.safeParse({});
    if (missing.success) throw new Error("expected invalid input");
    expect(projectInputIssues(missing.error.issues, {})).toEqual([
      { path: ["seed"], reason: "missing_argument", expected: "object" },
    ]);

    const input = { seed: { value: 1 } };
    const nested = schema.safeParse(input);
    if (nested.success) throw new Error("expected invalid input");
    expect(projectInputIssues(nested.error.issues, input)).toEqual(
      expect.arrayContaining([
        { path: ["seed", "value"], reason: "invalid_type", expected: "string" },
      ]),
    );
  });
});

describe("input issue argument guidance", () => {
  it("guides callers from neighboring-tool argument names while keeping unknown keys strict", () => {
    const input = { address: "0x401000", count: 10 };
    for (const op of [
      "read_function_instructions",
      "procedure_pseudo_code",
      "procedure_assembly",
    ] as const) {
      const parsed = officialContract(op).inputSchema.safeParse(input);
      if (parsed.success) throw new Error("expected invalid input");
      const error = analysisInputErrorFromIssues(
        op,
        parsed.error.issues,
        input,
      );
      expect(error.issues).toEqual([
        { path: ["procedure"], reason: "missing_argument", expected: "string" },
        {
          path: ["address"],
          reason: "unknown_argument",
          expected: "procedure",
          message: expect.stringMatching(/address.*procedure/i),
        },
        { path: ["count"], reason: "unknown_argument" },
      ]);
      const action = projectAnalysisError(error).remediation.action;
      expect(action).toMatch(/procedure.*address/i);
      expect(action).toContain(op);
    }

    const searchInput = { query: "flag" };
    for (const op of ["search_strings", "search_procedures"] as const) {
      const parsed = officialContract(op).inputSchema.safeParse(searchInput);
      if (parsed.success) throw new Error("expected invalid input");
      const searchError = analysisInputErrorFromIssues(
        op,
        parsed.error.issues,
        searchInput,
      );
      expect(searchError.issues).toEqual([
        { path: ["pattern"], reason: "missing_argument", expected: "string" },
        {
          path: ["query"],
          reason: "unknown_argument",
          expected: "pattern",
          message: expect.stringMatching(/query.*pattern/i),
        },
      ]);
      const action = projectAnalysisError(searchError).remediation.action;
      expect(action).toMatch(/pattern.*query/i);
      expect(action).toContain(op);
    }
  });

  it("guides callers for symmetric neighboring-tool argument names", () => {
    const addressInput = { procedure: "main" };
    for (const op of ["resolve_containing_procedure", "read_bytes"] as const) {
      const parsed = officialContract(op).inputSchema.safeParse(addressInput);
      if (parsed.success) throw new Error("expected invalid input");
      const error = analysisInputErrorFromIssues(
        op,
        parsed.error.issues,
        addressInput,
      );
      expect(error.issues).toEqual([
        { path: ["address"], reason: "missing_argument", expected: "string" },
        {
          path: ["procedure"],
          reason: "unknown_argument",
          expected: "address",
          message: expect.stringMatching(/procedure.*address/i),
        },
      ]);
      const action = projectAnalysisError(error).remediation.action;
      expect(action).toMatch(/address.*procedure/i);
      expect(action).toContain(op);
    }

    const xrefsParsed =
      officialContract("xrefs").inputSchema.safeParse(addressInput);
    if (xrefsParsed.success) throw new Error("expected invalid input");
    const xrefsError = analysisInputErrorFromIssues(
      "xrefs",
      xrefsParsed.error.issues,
      addressInput,
    );
    expect(xrefsError.issues).toEqual([
      {
        path: ["procedure"],
        reason: "unknown_argument",
        expected: "address",
        message: expect.stringMatching(/procedure.*address/i),
      },
    ]);
    const xrefsAction = projectAnalysisError(xrefsError).remediation.action;
    expect(xrefsAction).toMatch(/address.*procedure/i);
    expect(xrefsAction).toContain("xrefs");

    const queryInput = { pattern: "flag" };
    const queryCases = [
      {
        op: "search_guidance" as const,
        contract: applicationContract("search_guidance"),
      },
      {
        op: "trace_feature" as const,
        contract: enhancedContract("trace_feature"),
      },
    ];
    for (const { op, contract } of queryCases) {
      const parsed = contract.inputSchema.safeParse(queryInput);
      if (parsed.success) throw new Error("expected invalid input");
      const error = analysisInputErrorFromIssues(
        op,
        parsed.error.issues,
        queryInput,
      );
      expect(error.issues).toEqual([
        { path: ["query"], reason: "missing_argument", expected: "string" },
        {
          path: ["pattern"],
          reason: "unknown_argument",
          expected: "query",
          message: expect.stringMatching(/pattern.*query/i),
        },
      ]);
      const action = projectAnalysisError(error).remediation.action;
      expect(action).toMatch(/query.*pattern/i);
      expect(action).toContain(op);
    }
  });
});

describe("input issue argument guidance suppression", () => {
  it("suppresses replacement guidance when expected argument is already present", () => {
    const inputWithBoth = {
      procedure: "main",
      address: "0x401000",
      comment: "entry comment",
    };
    const parsed = officialContract(
      "annotate_native_function",
    ).inputSchema.safeParse(inputWithBoth);
    if (parsed.success) throw new Error("expected invalid input");
    const error = analysisInputErrorFromIssues(
      "annotate_native_function",
      parsed.error.issues,
      inputWithBoth,
    );
    expect(error.issues).toEqual([
      { path: ["address"], reason: "unknown_argument" },
    ]);
    const action = projectAnalysisError(error).remediation.action;
    expect(action).not.toMatch(/procedure.*instead of.*address/i);
    expect(action).toContain("annotate_native_function");

    const budgeted = projectFlattenedIssueGroups(
      parsed.error.issues,
      inputWithBoth,
      1024,
      "annotate_native_function",
    );
    expect(budgeted).toEqual(error.issues);

    const inputMissingExpected = {
      address: "0x401000",
      comment: "entry comment",
    };
    const parsedMissing = officialContract(
      "annotate_native_function",
    ).inputSchema.safeParse(inputMissingExpected);
    if (parsedMissing.success) throw new Error("expected invalid input");
    const errorMissing = analysisInputErrorFromIssues(
      "annotate_native_function",
      parsedMissing.error.issues,
      inputMissingExpected,
    );
    expect(errorMissing.issues).toContainEqual({
      path: ["address"],
      reason: "unknown_argument",
      expected: "procedure",
      message: expect.stringMatching(/address.*procedure/i),
    });
    const missingAction = projectAnalysisError(errorMissing).remediation.action;
    expect(missingAction).toMatch(/procedure.*address/i);
  });
});

describe("bounded input issue projection", () => {
  it("bounds union expansion before constructing field diagnostics", () => {
    const schema = z.object({
      value: z.union([
        z.object({ a: z.string(), b: z.number() }),
        z.object({ a: z.number(), c: z.string() }),
      ]),
    });
    const input = { value: { a: false } };
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error("expected invalid input");
    expect(
      projectFlattenedIssueGroups(parsed.error.issues, input, 32_768),
    ).toEqual(projectInputIssues(parsed.error.issues, input));
    expect(
      projectFlattenedIssueGroups(parsed.error.issues, input, 300),
    ).toBeUndefined();
  });

  it("checks a nested path before copying its components", () => {
    const input = { value: {} };
    const parsed = z
      .object({
        value: z.union([
          z.object({ a: z.string() }),
          z.object({ b: z.number() }),
        ]),
      })
      .safeParse(input);
    if (parsed.success) throw new Error("expected invalid input");
    const issue = parsed.error.issues[0];
    if (issue?.code !== "invalid_union")
      throw new Error("expected union issue");
    const child = issue.errors[0]?.[0];
    if (child === undefined) throw new Error("expected branch issue");
    let copied = false;
    const path = new Proxy(
      Array.from({ length: 1000 }, () => "field"),
      {
        get(target, key, receiver) {
          if (key === Symbol.iterator) copied = true;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const largePathIssue: z.core.$ZodIssue = {
      code: "invalid_union",
      path: issue.path,
      message: issue.message,
      errors: [[{ ...child, path }]],
    };
    expect(
      projectFlattenedIssueGroups([largePathIssue], input, 1024),
    ).toBeUndefined();
    expect(copied).toBe(false);
  });

  it("accounts for the repeated path on every unknown-key issue", () => {
    const issue: z.core.$ZodIssue = {
      code: "unrecognized_keys",
      path: Array.from({ length: 20 }, () => "nested"),
      keys: Array.from({ length: 10 }, (_, index) => `key_${String(index)}`),
      message: "Unrecognized keys",
    };
    expect(projectInputIssues([issue], {})).toHaveLength(10);
    expect(projectFlattenedIssueGroups([issue], {}, 5000)).toBeUndefined();
    const groups = projectInputIssueGroupsWithinBudget([issue], {}, 32_000);
    expect(groups).toHaveLength(1);
    expect(groups?.[0]).toHaveLength(10);
  });

  it("bounds pre-allocation budget accounting for guided unrecognized keys", () => {
    const issue: z.core.$ZodIssue = {
      code: "unrecognized_keys",
      path: [],
      keys: ["address"],
      message: "Unrecognized keys: address",
    };
    expect(projectFlattenedIssueGroups([issue], {}, 800)).toEqual([
      { path: ["address"], reason: "unknown_argument" },
    ]);

    expect(
      projectFlattenedIssueGroups(
        [issue],
        {},
        800,
        "read_function_instructions",
      ),
    ).toBeUndefined();

    expect(
      projectFlattenedIssueGroups(
        [issue],
        {},
        2000,
        "read_function_instructions",
      ),
    ).toEqual([
      {
        path: ["address"],
        reason: "unknown_argument",
        expected: "procedure",
        message: expect.stringMatching(/address.*procedure/i),
      },
    ]);
  });
});

describe("discriminated union input issue projection", () => {
  it("projects exact discriminator path and options when discriminated union has no errors", () => {
    const issue: z.core.$ZodIssue = {
      code: "invalid_union",
      errors: [],
      discriminator: "kind",
      options: ["node-id", "route", "string"],
      path: ["seed"],
      message: "Invalid discriminator value",
    };
    const input = { seed: { kind: "node" } };
    const projected = projectInputIssues([issue], input);
    expect(projected).toEqual([
      {
        path: ["seed", "kind"],
        reason: "invalid_value",
        expected: ["node-id", "route", "string"],
      },
    ]);
  });

  it("narrows plain union branches when an object matches a candidate discriminator key", () => {
    const schema = z.union([
      z.strictObject({
        kind: z.literal("node-id"),
        node_id: z.string().optional(),
        match: z.enum(["exact", "contains"]).default("exact"),
      }),
      z.strictObject({
        kind: z.literal("route"),
        route: z.string(),
      }),
    ]);
    const input = { kind: "node-id", match: "invalid_match" };
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error("expected invalid input");
    const projected = projectInputIssues(parsed.error.issues, input);
    // Should narrow to node-id branch only, ignoring missing 'route' from branch 2
    expect(projected).toEqual([
      {
        path: ["match"],
        reason: "invalid_value",
        expected: ["exact", "contains"],
      },
    ]);
  });

  it("reports a single discriminator diagnostic with all union options when tag matches no branch", () => {
    const schema = z.union([
      z.strictObject({
        kind: z.enum(["node-id", "route", "string"]),
        value: z.string(),
      }),
      z.strictObject({
        kind: z.literal("api"),
        endpoint: z.string(),
      }),
    ]);
    const input = { kind: "node", node_id: "jag_node_1" };
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error("expected invalid input");
    const projected = projectInputIssues(parsed.error.issues, input);
    // Should NOT emit missing value, unknown node_id, or missing endpoint from non-matching branches
    expect(projected).toEqual([
      {
        path: ["kind"],
        reason: "invalid_value",
        expected: ["node-id", "route", "string", "api"],
      },
    ]);
  });

  it("narrows branches when union includes a strict object variant without the discriminator key", () => {
    const schema = z.union([
      z.strictObject({
        kind: z.literal("target"),
        value: z.number(),
      }),
      z.strictObject({
        unrelated: z.string(),
      }),
    ]);
    const input = { kind: "target", value: "not-a-number" };
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error("expected invalid input");
    const projected = projectInputIssues(parsed.error.issues, input);
    expect(projected).toEqual([
      {
        path: ["value"],
        reason: "invalid_type",
        expected: "number",
      },
    ]);
  });
});

describe("union branch diagnostic merging", () => {
  it("merges disjoint expected sets at the identical path for homogeneous union failures", () => {
    const peFieldSchema = z.enum(["name", "ordinal", "address", "forwarder"]);
    const elfFieldSchema = z.enum([
      "name",
      "name_bytes_base64",
      "value",
      "size",
      "type",
      "binding",
    ]);
    const schema = z.object({
      fields: z.array(z.union([peFieldSchema, elfFieldSchema])),
    });
    const input = { fields: ["name", "symbol_type"] };
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error("expected invalid input");
    const projected = projectInputIssues(parsed.error.issues, input);
    expect(projected).toEqual([
      {
        path: ["fields", 1],
        reason: "invalid_value",
        expected: [
          "name",
          "ordinal",
          "address",
          "forwarder",
          "name_bytes_base64",
          "value",
          "size",
          "type",
          "binding",
        ],
      },
    ]);
  });

  it("merges scalar literal expected values at identical path", () => {
    const schema = z.union([z.literal("alpha"), z.literal("beta")]);
    const parsed = schema.safeParse("gamma");
    if (parsed.success) throw new Error("expected invalid input");
    expect(projectInputIssues(parsed.error.issues, "gamma")).toEqual([
      {
        path: [],
        reason: "invalid_value",
        expected: ["alpha", "beta"],
      },
    ]);
  });

  it("preserves distinct diagnostic reasons at identical path", () => {
    const schema = z.union([z.number(), z.literal("beta")]);
    const parsed = schema.safeParse("gamma");
    if (parsed.success) throw new Error("expected invalid input");
    expect(projectInputIssues(parsed.error.issues, "gamma")).toEqual([
      {
        path: [],
        reason: "invalid_type",
        expected: "number",
      },
      {
        path: [],
        reason: "invalid_value",
        expected: ["beta"],
      },
    ]);
  });
});

const testViewUnionSchema = z.union([
  z.strictObject({
    kind: z.literal("page"),
    collection: z.enum(["sections", "symbols", "modules"]),
    offset: z.number().int().default(0),
    limit: z.number().int().default(64),
  }),
  z.strictObject({
    kind: z.literal("javascript"),
    collection: z.literal("modules"),
    projection: z.literal("references"),
    offset: z.number().int().default(0),
    limit: z.number().int().default(64),
  }),
]);

describe("inspect_analysis_view cross-kind sub-selector guidance", () => {
  it("guides caller toward kind 'page' when javascript kind uses collection 'modules' without projection", () => {
    const input = {
      source: {
        kind: "retained-evidence",
        evidence_id: `ev_${"a".repeat(64)}`,
      },
      view: {
        kind: "javascript",
        collection: "modules",
        limit: 40,
        offset: 0,
      },
    };
    const schema = z.strictObject({
      source: z.unknown(),
      view: testViewUnionSchema,
    });
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error("expected invalid input");
    const projected = projectInputIssues(
      parsed.error.issues,
      input,
      "inspect_analysis_view",
    );
    expect(projected).toContainEqual(
      expect.objectContaining({
        path: ["view", "projection"],
        reason: "invalid_value",
        expected: ["references"],
        message: expect.stringMatching(/page.*modules/i),
      }),
    );
  });

  it("omits guidance message when operation is not inspect_analysis_view", () => {
    const input = {
      view: {
        kind: "javascript",
        collection: "modules",
        limit: 40,
        offset: 0,
      },
    };
    const schema = z.strictObject({ view: testViewUnionSchema });
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error("expected invalid input");
    const projected = projectInputIssues(
      parsed.error.issues,
      input,
      "other_operation",
    );
    expect(projected).toContainEqual(
      expect.objectContaining({
        path: ["view", "projection"],
        reason: "invalid_value",
        expected: ["references"],
      }),
    );
    expect(
      projected.find((p) => p.path.join(".") === "view.projection")?.message,
    ).toBeUndefined();
  });

  it("attaches guidance when wrapped in analysisOperationInputErrorFromIssues", () => {
    const input = {
      source: {
        kind: "retained-evidence",
        evidence_id: `ev_${"a".repeat(64)}`,
      },
      view: {
        kind: "javascript",
        collection: "modules",
        limit: 40,
        offset: 0,
      },
    };
    const schema = z.strictObject({
      operation: z.literal("inspect_analysis_view"),
      input: z.strictObject({
        source: z.unknown(),
        view: testViewUnionSchema,
      }),
    });
    const parsed = schema.safeParse({
      operation: "inspect_analysis_view",
      input,
    });
    if (parsed.success) throw new Error("expected invalid input");
    const error = analysisOperationInputErrorFromIssues(
      "inspect_analysis_view",
      parsed.error.issues,
      input,
      parsed.error,
    );
    expect(error.issues).toContainEqual(
      expect.objectContaining({
        path: ["view", "projection"],
        reason: "invalid_value",
        expected: ["references"],
        message: expect.stringMatching(/page.*modules/i),
      }),
    );
  });
});

describe("discriminated union nested alternatives and budget", () => {
  it("preserves valid discriminator options across nested alternatives before payload narrowing", () => {
    const input = { kind: "node", value: "main", match: "exact" };
    const parsed = applicationFeatureSeedSchema.safeParse(input);
    if (parsed.success) throw new Error("expected invalid input");
    const issues = projectInputIssues(parsed.error.issues, input);
    expect(issues).toEqual([
      {
        path: ["kind"],
        reason: "invalid_value",
        expected: [
          "node-id",
          "route",
          "string",
          "channel",
          "module",
          "native-export",
          "api",
        ],
      },
    ]);
  });

  it("retains missing field diagnostics alongside invalid enums when narrowed to one branch", () => {
    const input = { kind: "node-id", match: "bogus" };
    const parsed = applicationFeatureSeedSchema.safeParse(input);
    if (parsed.success) throw new Error("expected invalid input");
    const issues = projectInputIssues(parsed.error.issues, input);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["match"],
          reason: "invalid_value",
        }),
        expect.objectContaining({
          path: ["value"],
          reason: "missing_argument",
        }),
      ]),
    );
  });

  it("does not emit spurious sibling expected values when a nested alternative accepts a field", () => {
    const input = { kind: "api", value: "foo", case_sensitive: "bad" };
    const parsed = applicationFeatureSeedSchema.safeParse(input);
    if (parsed.success) throw new Error("expected invalid input");
    const issues = projectInputIssues(parsed.error.issues, input);
    expect(issues).toContainEqual(
      expect.objectContaining({
        path: ["case_sensitive"],
        reason: "invalid_type",
        expected: "boolean",
      }),
    );
    expect(issues.some((issue) => issue.path.join(".") === "value")).toBe(
      false,
    );
  });

  it("enforces projection budget and bounds discriminator candidate key checks", () => {
    const hugeInput: Record<string, unknown> = {
      kind: "unknown_kind",
    };
    for (let i = 0; i < 500; i += 1) {
      hugeInput[`extra_${String(i)}`] = `val_${String(i)}`;
    }
    const parsed = applicationFeatureSeedSchema.safeParse(hugeInput);
    if (parsed.success) throw new Error("expected invalid input");
    const bounded = projectInputIssuesBounded(
      parsed.error.issues,
      hugeInput,
      40,
    );
    expect(bounded.omittedIssueCount).toBeGreaterThan(0);
  });

  it("resolves setting discriminator before payload narrowing on analysis settings input", () => {
    const input = {
      changes: [{ setting: "bogus", action: "set", value: null }],
    };
    const parsed = updateAnalysisSettingsInputSchema.safeParse(input);
    if (parsed.success) throw new Error("expected invalid input");
    const issues = projectInputIssues(parsed.error.issues, input);
    expect(issues).toContainEqual(
      expect.objectContaining({
        path: ["changes", 0, "setting"],
        reason: "invalid_value",
        expected: expect.arrayContaining([
          "asar.max_header_bytes",
          "ghidra.startup_timeout_ms",
          "ghidra.decompile_timeout_seconds",
        ]),
      }),
    );
  });

  it("preserves invalid_type reason when all union variants reject candidate key on type", () => {
    const schema = z.union([
      z.object({ kind: z.string(), foo: z.string() }),
      z.object({ kind: z.number(), bar: z.string() }),
    ]);
    const input = { kind: true };
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error("expected invalid input");
    const issues = projectInputIssues(parsed.error.issues, input);
    expect(issues).toContainEqual(
      expect.objectContaining({
        path: ["kind"],
        reason: "invalid_type",
      }),
    );
    expect(issues.some((issue) => issue.reason === "invalid_value")).toBe(
      false,
    );
  });
});

describe("union discriminator variant selection and constraint preservation", () => {
  it("respects matched outer discriminator before secondary selector and retains selected branch errors", () => {
    const schema = z.union([
      z.strictObject({
        kind: z.literal("a"),
        mode: z.literal("fast"),
        value: z.string(),
      }),
      z.strictObject({
        kind: z.literal("b"),
        mode: z.literal("slow"),
        count: z.number(),
      }),
    ]);
    const input = { kind: "a", mode: "bogus" };
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error("expected invalid input");
    const issues = projectInputIssues(parsed.error.issues, input);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["mode"],
          reason: "invalid_value",
          expected: ["fast"],
        }),
        expect.objectContaining({
          path: ["value"],
          reason: "missing_argument",
        }),
      ]),
    );
    expect(issues.some((issue) => issue.path.join(".") === "count")).toBe(
      false,
    );
    const modeIssue = issues.find((issue) => issue.path.join(".") === "mode");
    expect(modeIssue?.expected).not.toContain("slow");

    const bounded = projectInputIssuesBounded(parsed.error.issues, input, 8192);
    expect(bounded.issues).toEqual(issues);
    expect(bounded.omittedIssueCount).toBe(0);
  });

  it("preserves non-value discriminator failures and does not collapse when a branch has range constraints", () => {
    const schema = z.union([
      z.strictObject({ kind: z.enum(["a", "b"]), foo: z.string() }),
      z.strictObject({ kind: z.string().min(5), bar: z.string() }),
    ]);
    const input = { kind: "x" };
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error("expected invalid input");
    const issues = projectInputIssues(parsed.error.issues, input);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ["kind"],
          reason: "invalid_value",
          expected: ["a", "b"],
        }),
        expect.objectContaining({
          path: ["kind"],
          reason: "out_of_range",
          minimum: 5,
        }),
      ]),
    );
  });
});
