import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { elf } from "../../../src/domain/binaryTarget.fixture.js";
import { parseEvidence, type Evidence } from "../../../src/domain/evidence.js";
import { functionComparisonResultSchema } from "../../../src/domain/functionComparisonSchemas.js";
import { ghidraFunctionDossier } from "../../../src/domain/ghidraValues.fixture.js";
import {
  jsonValueSchema,
  type JsonValue,
} from "../../../src/domain/jsonValue.js";
import { nativeFunctionMatchingSchema } from "../../../src/domain/native/functionMatching.js";
import type { NativeSymbolMetadata } from "../../../src/domain/native/nativeSymbol.js";
import { ok } from "../../../src/domain/result.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { connectGhidraMcp, sessionEvidence } from "./ghidraMcpHarness.js";

type RoleLabel = NonNullable<NativeSymbolMetadata["loader_role_label"]>;
const symbol = (label?: RoleLabel | "invalid") => ({
  primary: true,
  dynamic: false,
  external: false,
  type: "function",
  source: "imported",
  ...(label === undefined ? {} : { loader_role_label: label }),
});
const procedure = { external: false, thunk: false, thunk_target: null };
// Each side names its ELF header entry with Ghidra's loader label; the bodies
// at 0x201120 and 0x20113b are unrelated functions in the reported workflow.
const rows = (entry: string, label?: RoleLabel | "invalid") => [
  { address: entry, value: "entry", symbol: symbol(label), procedure },
  { address: "0x201200", value: "main", symbol: symbol(), procedure },
];

type ReportedLabel = RoleLabel | "invalid" | undefined;

const openTarget = async (side: "left" | "right", label: ReportedLabel) => {
  const root = await createTestTempDirectory(`rea-ghidra-role-${side}-`);
  const path = join(root, `${side}.elf`);
  const header = elf(2, 1, 62);
  header.writeUInt16LE(2, 16);
  header.writeBigUInt64LE(side === "left" ? 0x201120n : 0x20113bn, 24);
  await writeFile(path, header);
  const entry = side === "left" ? "0x201120" : "0x20113b";
  const harness = await connectGhidraMcp(
    `ghidra-loader-role-${side}`,
    (operation) => {
      if (operation === "list_procedures")
        return Promise.resolve(ok(jsonValueSchema.parse(rows(entry, label))));
      if (operation === "analyze_function") {
        const dossier = ghidraFunctionDossier() as {
          procedure: Record<string, JsonValue>;
        };
        dossier.procedure.name = "entry";
        dossier.procedure.symbol = jsonValueSchema.parse(symbol(label));
        return Promise.resolve(
          ok({ value: jsonValueSchema.parse(dossier), limitations: [] }),
        );
      }
      throw new Error(`Unexpected operation: ${operation}`);
    },
    { targetPath: path },
  );
  onTestFinished(harness.close);
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = await harness.mcp.callTool({ name, arguments: args });
    if (reply.isError === true) throw new Error(JSON.stringify(reply));
    return sessionEvidence(harness.session, reply.structuredContent);
  };
  return { harness, call };
};

const sides = async (label: ReportedLabel) => ({
  left: await openTarget("left", label),
  right: await openTarget("right", label),
});

const match = async (
  right: Awaited<ReturnType<typeof openTarget>>,
  leftInventory: Evidence,
  rightInventory: Evidence,
) => {
  const reply = await right.harness.mcp.callTool({
    name: "match_native_functions",
    arguments: {
      left: leftInventory,
      right: {
        kind: "retained-evidence",
        evidence_id: rightInventory.evidence_id,
      },
      detail: "complete",
    },
  });
  if (reply.isError === true) throw new Error(JSON.stringify(reply));
  return nativeFunctionMatchingSchema.parse(
    parseEvidence(reply.structuredContent).normalized_result,
  );
};

const groupFor = (
  report: ReturnType<typeof nativeFunctionMatchingSchema.parse>,
  name: string,
) =>
  report.matches.filter((group) =>
    [...group.left, ...group.right].some((member) => member.name === name),
  );

// compare_functions consumes the same parsed fact from independent dossiers.
const compareEntries = async (
  left: Awaited<ReturnType<typeof openTarget>>,
  right: Awaited<ReturnType<typeof openTarget>>,
) => {
  const dossier = { procedure: "entry", detail: "complete" };
  const compared = await right.harness.mcp.callTool({
    name: "compare_functions",
    arguments: {
      left: await left.call("analyze_function", dossier),
      right: await right.call("analyze_function", dossier),
    },
  });
  if (compared.isError === true) throw new Error(JSON.stringify(compared));
  return functionComparisonResultSchema.parse(
    parseEvidence(compared.structuredContent).normalized_result,
  );
};

it("keeps Ghidra loader-synthesized ELF entry labels from proving exact symbol correspondence", async () => {
  const { left, right } = await sides("synthesized");
  const leftInventory = await left.call("list_procedures", {});
  const rightInventory = await right.call("list_procedures", {});
  // The provider fact survives the adapter into retained inventory Evidence.
  expect(leftInventory.normalized_result).toMatchObject([
    {
      value: "entry",
      symbol: { source: "imported", loader_role_label: "synthesized" },
    },
    {
      value: "main",
      symbol: expect.not.objectContaining({
        loader_role_label: expect.anything(),
      }),
    },
  ]);
  const report = await match(right, leftInventory, rightInventory);
  expect(groupFor(report, "main")).toMatchObject([
    { state: "matched", basis: "exact-symbol" },
  ]);
  const entries = groupFor(report, "entry");
  expect(entries.map(({ state, basis }) => ({ state, basis }))).toEqual([
    { state: "only_left", basis: null },
    { state: "only_right", basis: null },
  ]);
  for (const group of entries)
    for (const member of [...group.left, ...group.right]) {
      expect(member.name).toBe("entry");
      expect(member.limitations).toContain(
        "Provider loader-synthesized role label; exact-name matching is unavailable. Independent complete body bytes remain eligible.",
      );
    }

  const comparison = await compareEntries(left, right);
  expect(comparison.function_match).toEqual({
    status: "ambiguous",
    method: "explicit",
    left_name: "entry",
    right_name: "entry",
  });
  expect(
    comparison.dimensions.find(({ dimension }) => dimension === "identity"),
  ).toMatchObject({ status: "unknown" });
});

it.each([
  { label: "artifact-symbol", state: "matched", basis: "exact-symbol" },
  { label: "unexamined", state: "only_left", basis: null },
] as const)(
  "keeps Ghidra $label entry labels on their observed origin",
  async ({ label, state, basis }) => {
    const { left, right } = await sides(label);
    const leftInventory = await left.call("list_procedures", {});
    const rightInventory = await right.call("list_procedures", {});
    const report = await match(right, leftInventory, rightInventory);
    const [first] = groupFor(report, "entry");
    expect(first).toMatchObject({ state, basis });
    if (label === "unexamined")
      expect(first!.left[0]!.limitations).toContain(
        "Symbol origin unavailable; exact-name matching is unavailable. Independent complete body bytes remain eligible.",
      );
    expect((await compareEntries(left, right)).function_match).toMatchObject(
      label === "artifact-symbol"
        ? { status: "matched", method: "symbol" }
        : { status: "ambiguous", method: "explicit" },
    );
  },
);

it("rejects an unknown Ghidra loader role label before creating Evidence", async () => {
  const left = await openTarget("left", "invalid");
  const reply = await left.harness.mcp.callTool({
    name: "list_procedures",
    arguments: {},
  });
  expect(reply.isError).toBe(true);
  expect(parseMcpToolError(reply)).toMatchObject({
    error: { code: "unreadable_output" },
  });
  expect(parseMcpToolError(reply)).not.toHaveProperty("evidence_id");
});
