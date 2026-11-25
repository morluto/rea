import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript6";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const workflows = join(root, ".github/workflows");

const parseWorkflow = async (name: string): Promise<unknown> =>
  parse(await readFile(join(workflows, name), "utf8"));

/** Whether `condition` evaluating to `outcome` proves the host is macOS. */
const provesDarwin = (
  condition: ts.Expression,
  outcome: boolean,
  constants: ReadonlyMap<string, ts.Expression>,
): boolean => {
  if (ts.isParenthesizedExpression(condition))
    return provesDarwin(condition.expression, outcome, constants);
  if (
    ts.isPrefixUnaryExpression(condition) &&
    condition.operator === ts.SyntaxKind.ExclamationToken
  )
    return provesDarwin(condition.operand, !outcome, constants);
  if (ts.isIdentifier(condition)) {
    const value = constants.get(condition.text);
    return value !== undefined && provesDarwin(value, outcome, constants);
  }
  if (!ts.isBinaryExpression(condition)) return false;
  const { left, right } = condition;
  const operator = condition.operatorToken.kind;
  const and = operator === ts.SyntaxKind.AmpersandAmpersandToken;
  if (and || operator === ts.SyntaxKind.BarBarToken) {
    // Both operands hold when `&&` is true or `||` is false; otherwise either may.
    const proofs = [left, right].map((side) =>
      provesDarwin(side, outcome, constants),
    );
    return and === outcome ? proofs.some(Boolean) : proofs.every(Boolean);
  }
  return (
    operator ===
      (outcome
        ? ts.SyntaxKind.EqualsEqualsEqualsToken
        : ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
    left.getText() === "process.platform" &&
    ts.isStringLiteral(right) &&
    right.text === "darwin"
  );
};

// shortcut: reads skipIf/runIf conditions and same-file constants only, not
// run-time context.skip() calls or imported gates; extend it if a suite uses one.
const hasDarwinOnlyCase = (source: string): boolean => {
  if (!source.includes('"darwin"')) return false;
  const file = ts.createSourceFile(
    "case.test.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const constants = new Map<string, ts.Expression>();
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      node.parent.flags & ts.NodeFlags.Const &&
      ts.isSourceFile(node.parent.parent.parent)
    )
      constants.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(file);
  const gated = (node: ts.Node): boolean => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.arguments[0] !== undefined
    ) {
      const gate = node.expression.name.text;
      if (
        (gate === "runIf" || gate === "skipIf") &&
        provesDarwin(node.arguments[0], gate === "runIf", constants)
      )
        return true;
    }
    return ts.forEachChild(node, gated) ?? false;
  };
  return gated(file);
};

it.each([
  ['it.skipIf(process.platform !== "darwin")("a", f)', true],
  ['describe.runIf(process.platform === "darwin")("a", f)', true],
  ['const mac = process.platform === "darwin";\nit.skipIf(!mac)("a", f)', true],
  [
    'it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("a", f)',
    true,
  ],
  ['it.runIf(process.platform === "darwin" && ready)("a", f)', true],
  [
    'const mac = process.platform === "darwin";\nit\n  .skipIf(!mac || root)\n  .each([1])("a", f)',
    true,
  ],
  [
    'it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("a", f)',
    false,
  ],
  [
    'it.runIf(process.platform === "linux" || process.platform === "darwin")("a", f)',
    false,
  ],
  ['it.skipIf(process.platform === "darwin")("a", f)', false],
  ['const mac = process.platform === "darwin";\nexpect(mac).toBe(true)', false],
  ['// it.skipIf(process.platform !== "darwin")', false],
])("classifies the darwin gate in %j", (source, expected) => {
  expect(hasDarwinOnlyCase(source)).toBe(expected);
});

// A darwin gate only skips the case off macOS, so a gated file that no macOS
// job names passes CI without ever running.
it("runs every file with darwin-only cases in a macOS job or records why it is manual", async () => {
  const { DARWIN_MANUAL_TESTS } = z
    .object({ DARWIN_MANUAL_TESTS: z.record(z.string(), z.string().min(1)) })
    .parse(
      await import(
        new URL("../../../scripts/ci/scopes.mjs", import.meta.url).href
      ),
    );
  const tracked = execFileSync("git", ["ls-files", "*.test.ts"], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  const sources = await Promise.all(
    tracked.map(async (path) => ({
      path,
      source: await readFile(join(root, path), "utf8"),
    })),
  );
  const gated = sources
    .filter(({ source }) => hasDarwinOnlyCase(source))
    .map(({ path }) => path);
  const schema = z.object({
    jobs: z.record(
      z.string(),
      z.object({
        "runs-on": z.unknown().optional(),
        steps: z.array(z.object({ run: z.string().optional() })).optional(),
      }),
    ),
  });
  const names = (await readdir(workflows)).filter((name) =>
    /\.ya?ml$/u.test(name),
  );
  const parsed = await Promise.all(
    names.map(async (name) => schema.parse(await parseWorkflow(name))),
  );
  const named = new Set(
    parsed
      .flatMap(({ jobs }) => Object.values(jobs))
      .filter((job) => JSON.stringify(job["runs-on"] ?? "").includes("macos"))
      .flatMap((job) => job.steps ?? [])
      .flatMap((step) => step.run?.split(/\s+/u) ?? []),
  );
  const manual = Object.keys(DARWIN_MANUAL_TESTS);
  expect(gated.length).toBeGreaterThan(0);
  expect(
    gated.filter((path) => !named.has(path) && !manual.includes(path)),
  ).toEqual([]);
  // A stale exemption hides a file that later loses its gate or gains a job.
  expect(
    manual.filter((path) => !gated.includes(path) || named.has(path)),
  ).toEqual([]);
});

// Selected test plans never include a scan of files they did not change.
it("runs this scan in static checks for every code or workflow change", async () => {
  const { jobs } = z
    .object({
      jobs: z.object({
        static: z.object({
          steps: z.array(
            z.object({ if: z.string().optional(), run: z.string().optional() }),
          ),
        }),
      }),
    })
    .parse(await parseWorkflow("ci.yml"));
  const scan = jobs.static.steps.find((step) =>
    step.run?.includes("darwinTestLanes.test.ts"),
  );
  expect(scan?.if).toBe(
    "needs.changes.outputs.code == 'true' || needs.changes.outputs.workflows == 'true'",
  );
  expect(scan?.run).toBe(
    "node scripts/run-exact-tests.mjs run tests/boundary/filesystem/darwinTestLanes.test.ts",
  );
});
