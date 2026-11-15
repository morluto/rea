import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES } from "../../../src/domain/analysisResourceLimits.js";
import { javaScriptMemberMutationRefusal } from "../../../src/domain/javascript/javascriptSemanticWorkAllowance.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { analyzeJavaScriptApplication } from "../../support/javascriptApplicationScope.js";

/** Four conditional self-selections before one member write (#8294). */
const SOURCE = [
  "function probe(input, env) { var m; if (env.first) m = env.first.info;",
  ...Array.from(
    { length: 4 },
    (_, index) =>
      `if (/case${String(index)}/.test(input)) m = m[${String(index % 2)}];`,
  ),
  "m[1] = input.length; return m; } module.exports = probe;",
].join(" ");

const createApplication = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-member-mutation-setting-");
  const app = join(root, "app");
  await mkdir(app);
  await writeFile(join(app, "main.js"), `${SOURCE}\n`);
  await writeFile(
    join(app, "package.json"),
    JSON.stringify({ name: "fixture", main: "main.js" }),
  );
  return app;
};

/** The per-source analysis failure the application graph retains. */
const sourceFailure = (value: unknown): Record<string, unknown> | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.analysis_failure === "object" &&
    record.analysis_failure !== null
  )
    return record.analysis_failure as Record<string, unknown>;
  for (const child of Object.values(record)) {
    const found = sourceFailure(child);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** The static coverage of the one source whose member-mutation phase was refused. */
const refusedCoverage = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const coverage = record.analysis_coverage as
    | { readonly examination?: { readonly refused_phase?: string } }
    | undefined;
  if (coverage?.examination?.refused_phase !== undefined) return record;
  for (const child of Object.values(record)) {
    const found = refusedCoverage(child);
    if (found !== undefined) return found;
  }
  return undefined;
};

it("applies the selected member-mutation allowance and reports it on refusal", async () => {
  const app = await createApplication();
  const admitted = await analyzeJavaScriptApplication({ input_path: app });
  if (!admitted.ok) throw admitted.error;
  expect(sourceFailure(admitted.value)).toBeUndefined();
  const cases = [
    {
      options: {
        environment: { REA_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES: "8" },
      },
      source: "setting",
    },
    {
      // The accepted runtime override wins over the launch seed.
      options: {
        environment: { REA_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES: "16" },
        settings: () => ({
          revision: 1,
          overrides: { "javascript.member_mutation_alias_states": 8 },
        }),
      },
      source: "runtime",
    },
  ] as const;
  for (const { options, source } of cases) {
    const refused = await analyzeJavaScriptApplication(
      { input_path: app },
      options,
    );
    if (!refused.ok) throw refused.error;
    // Structured limit facts, and the recovery the owning formatter gives.
    const owner = javaScriptMemberMutationRefusal(
      "analyze_javascript_application",
      { aliasStates: 8, source },
    );
    expect(sourceFailure(refused.value), source).toMatchObject({
      code: "resource_constraint",
      retryable: false,
      details: {
        limit: {
          setting: "javascript.member_mutation_alias_states",
          effective_value: 8,
          source,
          unit: "count",
          minimum: 1,
          maximum: MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
          update_mode: "runtime",
        },
      },
      remediation: { action: owner.remediationAction },
    });
    // The refused source keeps its syntax-level facts, marked with the phase.
    expect(refusedCoverage(refused.value), source).toMatchObject({
      path: "main.js",
      parse_status: "partial",
      analysis_coverage: {
        syntax: { status: "complete", error_count: 0 },
        examination: {
          status: "not-examined",
          refused_phase: "member-mutations",
        },
      },
    });
    expect(
      (
        refused.value.normalized_result as {
          readonly statistics: { readonly parsed_javascript_files: number };
        }
      ).statistics.parsed_javascript_files,
    ).toBe(1);
  }
  const raised = await analyzeJavaScriptApplication(
    { input_path: app },
    { environment: { REA_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES: "4096" } },
  );
  if (!raised.ok) throw raised.error;
  expect(sourceFailure(raised.value)).toBeUndefined();
  expect(refusedCoverage(raised.value)).toBeUndefined();
});

it("refuses a malformed launch seed before analysis", async () => {
  const app = await createApplication();
  const refused = await analyzeJavaScriptApplication(
    { input_path: app },
    { environment: { REA_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES: "0" } },
  );
  if (refused.ok) throw new Error("A malformed seed was admitted");
  expect(refused.error._tag).toBe("ConfigurationError");
});
