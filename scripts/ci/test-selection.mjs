import { matchesGlob, posix } from "node:path";

import { projectForTest } from "../lib/test-projects.mjs";
import { SHARED_BOUNDARY } from "./scopes.mjs";

// Pull-request feedback runs the tests a change most directly affects. Main
// pushes, schedules, releases and `ci:full` keep the complete suite, so a
// consumer the selection misses fails on main right after it lands.
// Selection falls back to the complete suite whenever it cannot decide.

/** More selected files than this run the complete suite instead. */
const SELECTION_CAP = 150;
// Selected files per test job, and the most jobs one selection uses. Each job
// runs one `--shard` of the selection; the CI sequencer balances the shards by
// main's recorded per-file durations when that history is available.
const FILES_PER_SHARD = 40;
const MAX_SHARDS = 4;

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
// Owners of what the built CLI and MCP server present: tool contracts,
// server registration and presentation, entrypoints and CLI commands.
const isPresentationOwner = (path) =>
  !isTest(path) &&
  /^src\/(?:server|contracts|main|cli)\/|^src\/(?:main|cli)\.ts$/u.test(path);
// A test that starts the built CLI or MCP server instead of importing it:
// the CLI launcher or this repository's built entry points. Other `dist/`
// paths (package subpaths such as `ajv/dist/2020.js`, fixture apps) are not.
const LAUNCHES_BUILT_RUNTIME =
  /scripts\/rea\.mjs|\bdist\/(?:main|cli)\.js|["'`]dist["'`]\s*,\s*["'`](?:main|cli)\.js/u;
// Inputs that only a non-test check reads: declarations (typecheck), guard
// baselines (architecture guards, static job) and the advertised-schema
// summaries (build job). They select no tests.
const isCheckerInput = (path) =>
  /\.d\.m?ts$/u.test(path) ||
  /^scripts\/verify\/baselines\/[^/]+\.json$/u.test(path) ||
  /^scripts\/verify\/advertised-schemas\/tools\/[^/]+\.json$/u.test(path);
// Verifier scripts are imported by their tests like source modules.
const isVerifier = (path) =>
  /^scripts\/(verify-[^/]+|verify\/.+)\.mjs$/u.test(path);
// Shared script modules. A change is traced through the tests, verifiers and
// other shared modules that import it; any other consumer (build, test
// runners, configuration) shapes every run, so it selects the full suite.
const isScriptLibrary = (path) =>
  !isCheckerInput(path) && /^scripts\/lib\/.+\.m?[jt]s$/u.test(path);
// Other scripts (build, test runners, CI) shape every run and are not traced.
const isModule = (path) =>
  !isCheckerInput(path) &&
  (/^(src|tests)\/.+\.m?ts$/u.test(path) ||
    isVerifier(path) ||
    isScriptLibrary(path));
// Test-only modules pass a change through to the tests that use them.
// Production importers never widen the selection transitively.
const isHelper = (path) =>
  !isTest(path) &&
  (/^tests\/.+\.m?ts$/u.test(path) ||
    /^src\/.+\.fixture[^/]*\.ts$/u.test(path) ||
    isVerifier(path) ||
    isScriptLibrary(path));
// Files outside src/ and tests/ that can run or load a shared script module:
// other scripts, root configuration, package metadata, hooks and workflows.
const isScriptConsumer = (path) =>
  !isHelper(path) &&
  !isCheckerInput(path) &&
  (/^scripts\/.+\.(?:m?[jt]s|cjs)$/u.test(path) ||
    (/^[^/]+\.(?:m?[jt]s|cjs|json)$/u.test(path) &&
      path !== "package-lock.json") ||
    /^\.github\/.+\.ya?ml$/u.test(path) ||
    /^\.husky\/[^/]+$/u.test(path));
// Prose that tests may read by path. Other non-module inputs (fixtures, data,
// scripts, workflows, package metadata) are not traced, so they run everything.
const isProse = (path) => path.endsWith(".md") && !/^(src|tests)\//u.test(path);
/** Why a changed path cannot be traced to tests, if it cannot. */
const untracedInput = (path) =>
  SHARED_BOUNDARY.test(path)
    ? `Shared boundary: ${path}`
    : !isModule(path) && !isProse(path) && !isCheckerInput(path)
      ? `Input is not traced to tests: ${path}`
      : undefined;

// Static and literal dynamic imports, mocks, and module URLs such as the
// `new URL("./x.mts", import.meta.url)` that `importVerifierSource` loads
// (scripts/lib/import-specifiers.mjs owns the exact parse; the planning job
// runs before dependencies are installed, so it cannot load that parser).
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.mock\(\s*|\bnew\s+URL\(\s*)["'](\.{1,2}\/[^"']+)["']/gu;
// TypeScript imports name the emitted `.js`/`.mjs`; scripts are imported as is.
const importsOf = (path, source) =>
  [...source.matchAll(SPECIFIER)].flatMap(([, specifier]) => {
    const target = posix.normalize(posix.join(posix.dirname(path), specifier));
    return [target, target.replace(/\.(m?)js$/u, ".$1ts")];
  });

/**
 * Trace the tests a change affects.
 *
 * `snapshot` lists the tracked paths of the revision under test and reads
 * them. `selected` maps each affected test to the first reason that selected
 * it: `changed`, `imports`, `built`, `beside`, `owner` or `names`. `untraced` names
 * inputs whose consumers cannot be traced to tests; CI runs the complete suite
 * for them, while a bounded local gate runs the traced selection.
 */
export function traceAffectedTests({ files, snapshot }) {
  const untraced = files.flatMap((path) => untracedInput(path) ?? []);

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

  // A seed and every helper that imports it, directly or through another.
  const throughHelpers = (seed) => {
    const reached = new Set(seed);
    for (let grew = true; grew;) {
      grew = false;
      for (const helper of helpers)
        if (
          !reached.has(helper) &&
          imports.get(helper).some((target) => reached.has(target))
        ) {
          reached.add(helper);
          grew = true;
        }
    }
    return reached;
  };
  // Close over test-only helpers, verifiers and shared script modules, then
  // take the tests that import a change.
  const affected = throughHelpers(changedModules);
  for (const test of tests)
    if (imports.get(test).some((target) => affected.has(target)))
      select(test, "imports");
  // Script paths a test can start or read by name: changed files, plus the
  // verifiers and shared modules a change reaches.
  const named = (reached) => [
    ...new Set([
      ...files,
      ...[...reached].filter((path) => path.startsWith("scripts/")),
    ]),
  ];
  const names = (test, paths) =>
    paths.some((path) => (sources.get(test) ?? "").includes(path));

  // A changed shared module that no test reaches has no coverage in a
  // selection, even when other changes select tests.
  for (const library of changedModules.filter(isScriptLibrary)) {
    const reached = throughHelpers([library]);
    const paths = named(reached);
    if (
      !tests.some(
        (test) =>
          imports.get(test).some((target) => reached.has(target)) ||
          names(test, paths),
      )
    )
      untraced.push(`No test reaches shared script module: ${library}`);
  }

  // A shared script module that another script, configuration file, hook or
  // workflow imports or names by file name can shape every run.
  const libraries = [...affected].filter(isScriptLibrary);
  if (libraries.length) {
    const consumers = tracked.filter(isScriptConsumer);
    const consumerSources = snapshot.read(consumers);
    for (const consumer of consumers) {
      const source = consumerSources.get(consumer) ?? "";
      const targets = new Set(importsOf(consumer, source));
      const library = libraries.find(
        (path) => targets.has(path) || source.includes(posix.basename(path)),
      );
      if (library !== undefined)
        untraced.push(
          `Script consumer is not traced: ${consumer} uses ${library}`,
        );
    }
  }

  // Tests that start the built CLI or MCP server reach a presentation owner
  // through the build rather than an import. Bound them to the tests that
  // also import a module from a changed owner's directory.
  const changedOwners = new Set(
    changedModules
      .filter(isPresentationOwner)
      .map((path) => posix.dirname(path)),
  );
  if (changedOwners.size) {
    const launchers = throughHelpers(
      helpers.filter((path) =>
        LAUNCHES_BUILT_RUNTIME.test(sources.get(path) ?? ""),
      ),
    );
    for (const test of tests) {
      const targets = imports.get(test);
      if (
        (LAUNCHES_BUILT_RUNTIME.test(sources.get(test) ?? "") ||
          targets.some((target) => launchers.has(target))) &&
        targets.some((target) => changedOwners.has(posix.dirname(target)))
      )
        select(test, "built");
    }
  }

  for (const path of changedModules) {
    // Same-stem tests, and same-directory tests that scan their directory's
    // sources by path instead of importing them.
    const stem = path.replace(/\.m?[jt]s$/u, "");
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
  // Tests that name a changed path, or a verifier or shared module the change
  // reaches, read or start it directly.
  const reachedPaths = named(affected);
  for (const test of tests)
    if (names(test, reachedPaths)) select(test, "names");
  return { selected, untraced };
}

const full = (reason) => ({ version: 3, mode: "full", reason });

/**
 * Plan the portable tests one CI run executes.
 *
 * `snapshot` lists the tracked paths of the revision under test and reads
 * them; it is consulted only when a subset is possible.
 */
export function planTestSelection({ files, event, tier, code, snapshot }) {
  // `ci:full` selects the full tier, so it also lands here.
  if (event !== "pull_request" || tier !== "fast")
    return full("Main, ci:full and qualification runs execute every test");
  if (!code) return full("No portable tests run for this change");
  if (!files.length) return full("No changed paths available");
  // Decide from the paths alone before reading the snapshot.
  const untracedPath = files.map(untracedInput).find(Boolean);
  if (untracedPath !== undefined) return full(untracedPath);
  const { selected, untraced } = traceAffectedTests({ files, snapshot });
  if (untraced.length) return full(untraced[0]);
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
  const reasons = Object.groupBy([...selected.values()], (reason) => reason);
  return {
    version: 3,
    mode: "selected",
    reason: `Affected tests: ${Object.entries(reasons)
      .map(([reason, entries]) => `${entries.length} ${reason}`)
      .join(", ")}`,
    files: paths,
    shards: Math.min(MAX_SHARDS, Math.ceil(paths.length / FILES_PER_SHARD)),
  };
}

/** Parse a plan produced by `planTestSelection`; anything else fails closed. */
export function parseTestSelection(value) {
  const plan = typeof value === "string" ? JSON.parse(value) : value;
  const files = plan?.files;
  const valid =
    plan?.version === 3 &&
    typeof plan.reason === "string" &&
    (plan.mode === "full"
      ? files === undefined && plan.shards === undefined
      : plan.mode === "selected" &&
        Array.isArray(files) &&
        files.length > 0 &&
        files.length <= SELECTION_CAP &&
        new Set(files).size === files.length &&
        files.every(
          (path) =>
            typeof path === "string" &&
            isTest(path) &&
            /^(src|tests)\//u.test(path) &&
            !path.split("/").some((part) => ["", ".", ".."].includes(part)),
        ) &&
        Number.isInteger(plan.shards) &&
        plan.shards >= 1 &&
        plan.shards <= Math.min(MAX_SHARDS, files.length));
  if (!valid) throw new Error("Invalid portable test selection plan");
  return plan;
}

// Fast feedback uses one source group and twelve built groups. Shards are
// balanced by recorded duration, but hosted runner speed varies, so the
// slowest shard sets the critical path: at eight shards it ran 24% above the
// mean shard. Smaller shards bound that excess at a few percent more runner
// time. Full qualification retains six complete shards with coverage. A
// selection runs its own shard count.
const shardsOf = (count) =>
  Array.from({ length: count }, (_, index) => `${index + 1}/${count}`);

/** The `test-shard` matrix labels for a tier and its test selection. */
export const testShards = (tier, plan) =>
  shardsOf(plan.mode === "selected" ? plan.shards : tier === "full" ? 6 : 12);
