import { matchesGlob, posix } from "node:path";

import { projectForTest } from "../lib/test-projects.mjs";
import { SHARED_BOUNDARY } from "./scopes.mjs";

// Pull-request feedback runs the tests a change most directly affects. Main
// pushes, schedules, releases and `ci:full` keep the complete suite, so a
// consumer the selection misses fails on main right after it lands.
// Selection falls back to the complete suite whenever it cannot decide.

/** More selected files than this run the complete suite instead. */
const SELECTION_CAP = 150;
/** Selected files per test job, and the most jobs one selection uses. */
const FILES_PER_GROUP = 40;
const MAX_GROUPS = 4;

// Leaf adapters whose tests also reach their sources through the built CLI,
// MCP server or a fake provider process rather than an import. An adapter
// owns `src/<name>/` and every test named for it (`<name>*.test.ts`) or
// filed under a `<name>/` directory anywhere in `tests/`.
const OWNERS = [
  "adb",
  "apktool",
  "dotnet",
  "evm",
  "firmware",
  "flutter",
  "ghidra",
  "hopper",
  "ida",
  "jeb",
  "pcap",
  "sqlite",
  "wasm",
];
const ownedTests = (path) =>
  OWNERS.filter((owner) => path.startsWith(`src/${owner}/`)).flatMap(
    (owner) => [`tests/**/${owner}/**/*.test.ts`, `tests/**/${owner}*.test.ts`],
  );

const isTest = (path) => path.endsWith(".test.ts");
// Inputs that only a non-test check reads: declarations (typecheck), guard
// baselines (architecture guards, static job) and the advertised-schema
// summaries (build job). They select no tests.
const isCheckerInput = (path) =>
  /\.d\.m?ts$/u.test(path) ||
  /^scripts\/verify\/baselines\/[^/]+\.json$/u.test(path) ||
  /^scripts\/verify\/advertised-schemas\/tools\/[^/]+\.json$/u.test(path);
// Verifier scripts are imported by their tests like source modules. Other
// scripts (build, test runners, CI) shape every run and are not traced.
const isModule = (path) =>
  !isCheckerInput(path) &&
  (/^(src|tests)\/.+\.m?ts$/u.test(path) ||
    /^scripts\/(verify-[^/]+|verify\/.+)\.mjs$/u.test(path));
// Test-only modules pass a change through to the tests that use them.
// Production importers never widen the selection transitively.
const isHelper = (path) =>
  !isTest(path) &&
  (/^tests\/.+\.m?ts$/u.test(path) ||
    /^src\/.+\.fixture[^/]*\.ts$/u.test(path));
// Prose that tests may read by path. Other non-module inputs (fixtures, data,
// scripts, workflows, package metadata) are not traced, so they run everything.
const isProse = (path) => path.endsWith(".md") && !/^(src|tests)\//u.test(path);

const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.mock\(\s*)["'](\.{1,2}\/[^"']+)["']/gu;
// TypeScript imports name the emitted `.js`/`.mjs`; scripts are imported as is.
const importsOf = (path, source) =>
  [...source.matchAll(SPECIFIER)].flatMap(([, specifier]) => {
    const target = posix.normalize(posix.join(posix.dirname(path), specifier));
    return [target, target.replace(/\.(m?)js$/u, ".$1ts")];
  });

const full = (reason) => ({ version: 2, mode: "full", reason, groups: [] });

/**
 * Plan the portable tests one CI run executes.
 *
 * `snapshot` lists the tracked `src/` and `tests/` paths of the revision under
 * test and reads them; it is consulted only when a subset is possible.
 */
export function planTestSelection({ files, event, tier, code, snapshot }) {
  // `ci:full` selects the full tier, so it also lands here.
  if (event !== "pull_request" || tier !== "fast")
    return full("Main, ci:full and qualification runs execute every test");
  if (!code) return full("No portable tests run for this change");
  if (!files.length) return full("No changed paths available");
  for (const path of files) {
    if (SHARED_BOUNDARY.test(path)) return full(`Shared boundary: ${path}`);
    if (!isModule(path) && !isProse(path) && !isCheckerInput(path))
      return full(`Input is not traced to tests: ${path}`);
  }

  const tracked = snapshot.list();
  const trackedSet = new Set(tracked);
  const tests = tracked.filter(isTest);
  const helpers = tracked.filter(isHelper);
  const sources = snapshot.read([...tests, ...helpers]);
  const imports = new Map(
    [...tests, ...helpers].map((path) => [
      path,
      importsOf(path, sources.get(path) ?? ""),
    ]),
  );

  const selected = new Map();
  const select = (path, reason) => {
    if (trackedSet.has(path) && !selected.has(path)) selected.set(path, reason);
  };
  const changedModules = files.filter(
    (path) => isModule(path) && !isTest(path),
  );
  for (const path of files) if (isTest(path)) select(path, "changed");

  // Close over test-only helpers, then take the tests that import a change.
  const affected = new Set(changedModules);
  for (let grew = true; grew;) {
    grew = false;
    for (const helper of helpers)
      if (
        !affected.has(helper) &&
        imports.get(helper).some((target) => affected.has(target))
      ) {
        affected.add(helper);
        grew = true;
      }
  }
  for (const test of tests)
    if (imports.get(test).some((target) => affected.has(target)))
      select(test, "imports");

  for (const path of changedModules) {
    // Same-stem tests, and same-directory tests that scan their directory's
    // sources by path instead of importing them.
    const stem = path.replace(/\.m?ts$/u, "");
    for (const test of tests)
      if (
        posix.dirname(test) === posix.dirname(path) &&
        (test.startsWith(`${stem}.`) ||
          /\breaddir(?:Sync)?\s*\(/u.test(sources.get(test) ?? ""))
      )
        select(test, "beside");
    // Leaf adapters' boundary tests.
    const patterns = ownedTests(path);
    for (const test of tests)
      if (patterns.some((glob) => matchesGlob(test, glob)))
        select(test, "owner");
  }
  // Tests that name a changed path read it directly.
  for (const path of files)
    for (const test of tests)
      if ((sources.get(test) ?? "").includes(path)) select(test, "names");

  const paths = [...selected.keys()].sort();
  if (!paths.length)
    return full("No test imports, names or sits beside a changed path");
  if (paths.length > SELECTION_CAP)
    return full(
      `${paths.length} affected test files exceed the ${SELECTION_CAP}-file selection cap`,
    );
  for (const path of paths)
    try {
      projectForTest(path);
    } catch {
      return full(`No single test project runs ${path}`);
    }
  const count = Math.min(MAX_GROUPS, Math.ceil(paths.length / FILES_PER_GROUP));
  const groups = Array.from({ length: count }, () => []);
  paths.forEach((path, index) => groups[index % count].push(path));
  const reasons = Object.groupBy([...selected.values()], (reason) => reason);
  return {
    version: 2,
    mode: "selected",
    reason: `Affected tests: ${Object.entries(reasons)
      .map(([reason, entries]) => `${entries.length} ${reason}`)
      .join(", ")}`,
    groups,
  };
}

/** Parse a plan produced by `planTestSelection`; anything else fails closed. */
export function parseTestSelection(value) {
  const plan = typeof value === "string" ? JSON.parse(value) : value;
  const valid =
    plan?.version === 2 &&
    typeof plan.reason === "string" &&
    Array.isArray(plan.groups) &&
    (plan.mode === "full"
      ? plan.groups.length === 0
      : plan.mode === "selected" &&
        plan.groups.length >= 1 &&
        plan.groups.length <= MAX_GROUPS &&
        plan.groups.every(
          (group) =>
            Array.isArray(group) &&
            group.length > 0 &&
            group.every(
              (path) =>
                typeof path === "string" &&
                isTest(path) &&
                /^(src|tests)\//u.test(path) &&
                !path.split("/").some((part) => ["", ".", ".."].includes(part)),
            ),
        ) &&
        new Set(plan.groups.flat()).size === plan.groups.flat().length &&
        plan.groups.flat().length <= SELECTION_CAP);
  if (!valid) throw new Error("Invalid portable test selection plan");
  return plan;
}

// Fast feedback uses one source group and twelve built groups. Shards are
// balanced by recorded duration, but hosted runner speed varies, so the
// slowest shard sets the critical path: at eight shards it ran 24% above the
// mean shard. Smaller shards bound that excess at a few percent more runner
// time. Full qualification retains six complete shards with coverage. A
// selection runs one job per group.
const shardsOf = (count) =>
  Array.from({ length: count }, (_, index) => `${index + 1}/${count}`);

/** The `test-shard` matrix labels for a tier and its test selection. */
export const testShards = (tier, plan) =>
  shardsOf(
    plan.mode === "selected" ? plan.groups.length : tier === "full" ? 6 : 12,
  );
