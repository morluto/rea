import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  analysisInputErrorFromIssues,
  projectInputIssues,
  projectInputIssueGroupsWithinBudget,
} from "./inputIssueProjection.js";
import { projectAnalysisError } from "./analysisErrorProjection.js";
import { processScenarioSchema } from "./process/processScenario.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../contracts/officialToolContracts.js";
import { APPLICATION_TOOL_CONTRACTS } from "../contracts/applicationToolContracts.js";
import { ENHANCED_TOOL_CONTRACTS } from "../contracts/enhancedToolContracts.js";
import { knownArgumentMistakeGuidance } from "./inputArgumentGuidance.js";

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
      const guidance = knownArgumentMistakeGuidance(op, "address");
      expect(guidance).toBeDefined();
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
          message: guidance!.message,
        },
        { path: ["count"], reason: "unknown_argument" },
      ]);
      const action = projectAnalysisError(error).remediation.action;
      expect(action.startsWith(guidance!.remediation)).toBe(true);
      expect(action).toContain(op);
    }

    const searchInput = { query: "flag" };
    for (const op of ["search_strings", "search_procedures"] as const) {
      const guidance = knownArgumentMistakeGuidance(op, "query");
      expect(guidance).toBeDefined();
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
          message: guidance!.message,
        },
      ]);
      const action = projectAnalysisError(searchError).remediation.action;
      expect(action.startsWith(guidance!.remediation)).toBe(true);
      expect(action).toContain(op);
    }
  });

  it("guides callers for symmetric neighboring-tool argument names", () => {
    const addressInput = { procedure: "main" };
    for (const op of ["resolve_containing_procedure", "read_bytes"] as const) {
      const guidance = knownArgumentMistakeGuidance(op, "procedure");
      expect(guidance).toBeDefined();
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
          message: guidance!.message,
        },
      ]);
      const action = projectAnalysisError(error).remediation.action;
      expect(action.startsWith(guidance!.remediation)).toBe(true);
      expect(action).toContain(op);
    }

    const xrefsGuidance = knownArgumentMistakeGuidance("xrefs", "procedure");
    expect(xrefsGuidance).toBeDefined();
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
        message: xrefsGuidance!.message,
      },
    ]);
    const xrefsAction = projectAnalysisError(xrefsError).remediation.action;
    expect(xrefsAction.startsWith(xrefsGuidance!.remediation)).toBe(true);
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
      const guidance = knownArgumentMistakeGuidance(op, "pattern");
      expect(guidance).toBeDefined();
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
          message: guidance!.message,
        },
      ]);
      const action = projectAnalysisError(error).remediation.action;
      expect(action.startsWith(guidance!.remediation)).toBe(true);
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
    const suppressedGuidance = knownArgumentMistakeGuidance(
      "annotate_native_function",
      "address",
    );
    expect(suppressedGuidance).toBeDefined();
    expect(action).not.toContain(suppressedGuidance!.remediation);
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
    const missingGuidance = knownArgumentMistakeGuidance(
      "annotate_native_function",
      "address",
    );
    expect(missingGuidance).toBeDefined();
    expect(errorMissing.issues).toContainEqual({
      path: ["address"],
      reason: "unknown_argument",
      expected: "procedure",
      message: missingGuidance!.message,
    });
    const missingAction = projectAnalysisError(errorMissing).remediation.action;
    expect(missingAction.startsWith(missingGuidance!.remediation)).toBe(true);
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

    const guidance = knownArgumentMistakeGuidance(
      "read_function_instructions",
      "address",
    );
    expect(guidance).toBeDefined();
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
        message: guidance!.message,
      },
    ]);
  });
});
