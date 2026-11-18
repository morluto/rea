import { execFileSync } from "node:child_process";
import { matchesGlob } from "node:path";
import { isLivingProsePath } from "../lib/docs-facts.mjs";
import {
  CI_FLAGS as flags,
  MANUAL_VERIFIERS,
  CI_LANES,
  SHARED_BOUNDARY,
  WINDOWS_EXECUTABLE_SELECTION_INPUTS,
} from "./scopes.mjs";
import { planTestSelection, testShards } from "./test-selection.mjs";

// Actionlint validates workflow syntax only. The semantic suite asserts these
// workflows' release, publication and self-hosted runner safeguards.
const GUARDED_WORKFLOWS = new Set([
  ".github/workflows/codeql.yml",
  ".github/workflows/pr-title.yml",
  ".github/workflows/pr-readiness.yml",
  ".github/workflows/ci-full-pr.yml",
  ".github/workflows/release.yml",
  ".github/workflows/release-recovery.yml",
  ".github/workflows/real-ghidra-windows.yml",
  ".github/workflows/sqlite-runtime.yml",
  ".github/workflows/ci-timings.yml",
  ".github/workflows/cache-retention.yml",
  ".github/workflows/mutation.yml",
]);
// Sources compiled by build-conformance-fixtures.mjs. The readiness journey
// analyzes the built C fixture as well as its own applications.
const FIXTURE_SOURCES = [
  "scripts/build-conformance-fixtures.mjs",
  "scripts/verify-conformance-fixtures.mjs",
  "scripts/lib/conformance-fixtures.mjs",
  "tests/conformance/c/**",
  "tests/conformance/napi/**",
  "tests/conformance/objc/**",
  "tests/conformance/swift/**",
  "tests/conformance/versions/**",
];
// These reporters affect CI output only; they do not select a host or provider
// verification lane when changed on their own.
const PORTABLE_CI_REPORTERS = new Set([
  "scripts/ci/job-timings.mjs",
  "scripts/ci/job-timings-batch.mjs",
  "scripts/ci/test-report.mjs",
  "scripts/ci/test-timing-reporter.mjs",
  "scripts/ci/test-history.mjs",
]);
// Static architecture/lint/schema/test-project verifiers and baselines run in
// static/build/portable lanes (`code: true`) without requiring host package lanes.
const STATIC_CODE_ONLY_INPUTS = [
  "scripts/lib/module-layers.baseline.json",
  "scripts/lib/module-layers.*",
  "scripts/lib/module-boundaries.*",
  "scripts/verify-module-boundaries.mjs",
  "scripts/verify/architecture-guards.mjs",
  "scripts/verify/*-guard.*",
  "scripts/verify/rea-numeric-limits.mjs",
  "scripts/verify/source-tokens.*",
  "scripts/verify/keyed-first-match.*",
  "scripts/verify/reason-marker.*",
  "scripts/verify/baselines/*.json",
  "scripts/lint/**",
  ".oxlintrc.json",
  ".oxfmtrc.json",
  ".jscpd.json",
  "knip.json",
  "tsconfig.scripts.json",
  "scripts/verify-advertised-schemas.mjs",
  "scripts/verify/advertised-schemas/**",
  "scripts/verify/mcp-client-validation.*",
  "scripts/verify-test-discovery.mjs",
  "scripts/verify-test-temp-hygiene.mjs",
  "scripts/lib/test-projects.mjs",
];
// Documentation and product-catalog verifiers/generators exercised by `docs:check`
// and portable tests without changing packaged host behavior.
const DOCS_AND_CODE_INPUTS = [
  "scripts/check-doc-facts.mjs",
  "scripts/generate-error-schema.mjs",
  "scripts/lib/product-catalog.*",
  "scripts/lib/catalog-core.*",
  "scripts/lib/catalog-cli.*",
];
const matchesAny = (file, patterns) =>
  patterns.some((pattern) => matchesGlob(file, pattern));

/**
 * Plan the CI lanes for one event. `repository` answers the Git questions the
 * plan asks, so the classification runs without a process per decision.
 *
 * @param {import("./change-plan.d.mts").ChangePlanRequest} request
 * @param {import("./change-plan.d.mts").ChangePlanRepository} repository
 * @returns {import("./change-plan.d.mts").ChangePlan}
 */
export function planChanges(request, repository) {
  const selected = Object.fromEntries(flags.map((flag) => [flag, false]));
  const reasons = [];
  const full = (reason) => {
    if (tier === "full") {
      for (const flag of flags) selected[flag] = true;
    } else {
      selected.code = true;
      selected.runtime = true;
    }
    reasons.push(reason);
  };
  function classifyPackage(base, head) {
    const before = JSON.parse(repository.readFile(base, "package.json"));
    const after = JSON.parse(repository.readFile(head, "package.json"));
    const { scripts: beforeScripts, ...beforeRest } = before;
    const { scripts: afterScripts, ...afterRest } = after;
    const compilerDependencies = (metadata) => ({
      dependencies: {
        typescript: metadata.dependencies?.typescript,
        tsrs: metadata.dependencies?.tsrs,
      },
      devDependencies: {
        typescript: metadata.devDependencies?.typescript,
        tsrs: metadata.devDependencies?.tsrs,
      },
    });
    const compilerScripts = [
      "compile",
      "typecheck",
      "build",
      "build:cached",
      "test:prepare",
      "docs:prepare",
      "verify:frida:bindings",
    ].flatMap((name) => [name, `pre${name}`, `post${name}`]);
    selected.package ||=
      JSON.stringify(compilerDependencies(before)) !==
        JSON.stringify(compilerDependencies(after)) ||
      compilerScripts.some(
        (name) => beforeScripts?.[name] !== afterScripts?.[name],
      );
    if (JSON.stringify(beforeRest) !== JSON.stringify(afterRest)) {
      full("Package metadata or dependencies changed");
      return;
    }
    selected.code = true;
    const changed = [
      ...new Set([
        ...Object.keys(beforeScripts ?? {}),
        ...Object.keys(afterScripts ?? {}),
      ]),
    ].filter((key) => beforeScripts?.[key] !== afterScripts?.[key]);
    for (const script of changed) {
      if (/^test:(coverage|mutation):reverse-tools$/.test(script)) {
        selected.reverse_tools = true;
        continue;
      }
      if (script === "test:python") {
        selected.python = true;
        continue;
      }
      if (script === "test:sqlite" || script === "test:sqlite:run") {
        selected.sqlite = true;
        continue;
      }
      if (
        /^(test(?::|$)|check(?::|$)|lint(?::|$)|format(?::|$)|knip(?::|$)|jscpd$)/.test(
          script,
        )
      )
        continue;
      if (
        ["compile:termux", "build:termux", "build:termux:run"].includes(script)
      ) {
        selected.workflows = true;
        reasons.push(
          `Android build script changed; real Android verification remains manual: ${script}`,
        );
        continue;
      }
      // Verify scripts own provider setup as well as execution. Reuse their
      // existing source-file ownership rather than maintaining a second map.
      const entrypoint = (command) =>
        /^(?:npm run build:cached && )?node (scripts\/[\w/-]+\.mjs)(?: [\w./=-]+)*$/.exec(
          command ?? "",
        )?.[1];
      const beforeEntry = entrypoint(beforeScripts?.[script]);
      const afterEntry = entrypoint(afterScripts?.[script]);
      const entries = [beforeEntry, afterEntry].filter(Boolean);
      const simple =
        (!beforeScripts?.[script] || beforeEntry) &&
        (!afterScripts?.[script] || afterEntry);
      const scriptOwners =
        simple &&
        entries.every((entry) =>
          Object.values(CI_LANES).some(({ paths }) => matchesAny(entry, paths)),
        )
          ? Object.entries(CI_LANES)
              .filter(([, { paths }]) =>
                entries.some((entry) => matchesAny(entry, paths)),
              )
              .map(([owner]) => owner)
          : [];
      if (scriptOwners.length)
        for (const owner of scriptOwners) selected[owner] = true;
      else full(`Shared or unknown package script: ${script}`);
    }
  }

  const { event } = request;
  if (
    !["pull_request", "push", "schedule", "workflow_dispatch"].includes(event)
  )
    throw new Error(`Unsupported CI event: ${event}`);
  const requestedFull =
    event === "schedule" || event === "workflow_dispatch" || request.full;
  const tier =
    event === "schedule" && request.skipFull && !request.full
      ? "reused"
      : requestedFull
        ? "full"
        : "fast";
  /** Select the lanes one changed path owns. */
  const classifyFile = (file, base, head) => {
    selected.package ||= matchesAny(file, WINDOWS_EXECUTABLE_SELECTION_INPUTS);
    for (const [owner, { paths, earlyAll, earlyInputs = [] }] of Object.entries(
      CI_LANES,
    ))
      if (matchesAny(file, earlyAll ? paths : earlyInputs))
        selected[owner] = true;
    // The documentation check scans living prose outside docs/ too.
    if (isLivingProsePath(file)) selected.docs = true;
    if (file === ".git-blame-ignore-revs") return;
    if (
      file.startsWith("licenses/") ||
      file === "THIRD_PARTY_NOTICES.md" ||
      file === "DISCLAIMER.md" ||
      file === "LICENSE"
    ) {
      selected.docs = true;
      selected.code = true;
      return;
    }
    if (
      /^(README(?:_[^/]+)?\.md|AGENTS\.md|CONTRIBUTING\.md|CHANGELOG\.md|SECURITY\.md|native\/windows\/README\.md|\.github\/pull_request_template\.md)$/.test(
        file,
      ) ||
      file.startsWith("docs/") ||
      file === "scripts/verify-documentation-routes.mjs" ||
      file.startsWith(".github/ISSUE_TEMPLATE/")
    ) {
      selected.docs = true;
      // Authored code and its Node package scopes belong to static checkers.
      selected.code ||=
        file.startsWith("docs/") &&
        (/\.(?:[cm]?[jt]s|[jt]sx)$/u.test(file) ||
          file.endsWith("/package.json"));
      // Authored docs copied into a shipped artifact also own package checks.
      const packaged =
        file.startsWith("docs/") && matchesAny(file, CI_LANES.package.paths);
      selected.package ||= packaged;
      selected.code ||= packaged;
      selected.website ||= matchesAny(file, CI_LANES.website.paths);
      return;
    }
    if (/^(src|tests)\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) {
      selected.code = true;
      for (const [owner, { paths, testInputs }] of Object.entries(CI_LANES))
        if (testInputs && matchesAny(file, paths)) selected[owner] = true;
      return;
    }
    if (matchesAny(file, MANUAL_VERIFIERS)) {
      selected.code = true;
      return;
    }
    // Timing and report helpers stay on the portable suite. They are not a
    // runtime or provider change.
    if (PORTABLE_CI_REPORTERS.has(file)) {
      selected.code = true;
      return;
    }
    if (matchesAny(file, DOCS_AND_CODE_INPUTS)) {
      selected.docs = true;
      selected.code = true;
      return;
    }
    if (matchesAny(file, STATIC_CODE_ONLY_INPUTS)) {
      selected.code = true;
      return;
    }
    // A shared boundary is not evidence that every provider or host changed.
    // One lane that names the file is path evidence; a lane that only covers
    // it through a `**` directory glob is not. Several naming lanes means the
    // same registration file is listed by many lanes; fast qualification does
    // not fan those out or start the multi-host package matrix.
    if (tier !== "full" && SHARED_BOUNDARY.test(file)) {
      selected.code = true;
      selected.runtime = true;
      const owners = Object.entries(CI_LANES)
        .filter(([, { paths }]) =>
          matchesAny(
            file,
            paths.filter((pattern) => !pattern.includes("**")),
          ),
        )
        .map(([owner]) => owner);
      if (owners.length === 1) selected[owners[0]] = true;
      reasons.push(`Shared boundary on fast tier: ${file}`);
      return;
    }
    const owners = Object.entries(CI_LANES)
      .filter(([, { paths }]) => matchesAny(file, paths))
      .map(([owner]) => owner);
    for (const owner of owners) selected[owner] = true;
    if (
      file.startsWith(".github/workflows/") ||
      file.startsWith(".github/codeql/") ||
      file === ".github/actionlint.yaml"
    ) {
      selected.workflows = true;
      if (GUARDED_WORKFLOWS.has(file) || file.startsWith(".github/codeql/"))
        selected.code = true;
      if (file !== ".github/workflows/ci.yml") return;
    }
    // The Notes example is also the source-owned agent evaluation fixture.
    if (file.startsWith("website/public/examples/notes-electron/"))
      selected.code = true;
    if (owners.length === 1 && owners[0] === "website") return;
    if (/^src\/(contracts|domain)\//.test(file)) selected.docs = true;
    if (file === "package.json") {
      classifyPackage(base, head);
      return;
    }
    selected.code = true;
    if (matchesAny(file, FIXTURE_SOURCES)) {
      selected.fixtures = true;
      selected.readiness = true;
    }
    if (file.startsWith("tests/")) return;
    if (SHARED_BOUNDARY.test(file)) {
      full(`Shared boundary: ${file}`);
    } else if (owners.length) {
      if (file.startsWith("src/") || file.startsWith("bridge/"))
        selected.runtime = true;
    } else if (/^(src|bridge)\//.test(file)) {
      // Unowned runtime sources keep the Linux x64 installed-package baseline;
      // full qualification retains every native host.
      selected.runtime = true;
      reasons.push(`Unowned runtime source: ${file}`);
    } else if (
      file.startsWith(".agents/skills/") ||
      file.startsWith(".cursor-plugin/skills/")
    ) {
      selected.runtime = true;
      selected.docs = true;
    } else {
      full(`Unclassified input: ${file}`);
    }
  };
  let files = [];
  if (tier === "reused") {
    reasons.push(
      "Recent exact-SHA full qualification reused; no fresh provider observation",
    );
  } else if (tier === "full") {
    full("Full baseline requested by event or ci:full label");
  } else if (event === "pull_request" || event === "push") {
    const { head } = request;
    let base;
    if (event === "pull_request") {
      base = repository.mergeBase(request.base, head);
    } else {
      const candidate = request.base;
      const { baselineReason } = request;
      try {
        if (!candidate || !/^[0-9a-f]{40}$/i.test(candidate))
          throw new Error(
            baselineReason || "No valid successful push baseline was found",
          );
        if (!repository.isAncestor(candidate, head))
          throw new Error("Push baseline is not an ancestor");
        base = candidate;
      } catch {
        full(
          baselineReason ||
            "No valid successful push baseline ancestor; selecting all lanes",
        );
      }
    }
    if (base) {
      // Disable rename detection so both the removed and added paths participate.
      files = repository.changedFiles(base, head);
      for (const file of files) classifyFile(file, base, head);
    }
  }
  selected.runtime ||= selected.package;
  const linux = { os: "ubuntu-latest", platform: "linux", architecture: "x64" };
  // macOS x64 is the slowest package host. Fast qualification omits it.
  const intel =
    tier === "full"
      ? [{ os: "macos-15-intel", platform: "darwin", architecture: "x64" }]
      : [];
  const matrix = {
    include: selected.package
      ? [
          linux,
          { os: "ubuntu-24.04-arm", platform: "linux", architecture: "arm64" },
          { os: "macos-15", platform: "darwin", architecture: "arm64" },
          ...intel,
        ]
      : [linux],
  };
  const testSelection = planTestSelection({
    files,
    event,
    tier,
    code: selected.code,
    // The checked-out revision is the one whose tests run. Script and
    // configuration files are listed so shared script modules can be traced.
    snapshot: {
      list: () => repository.listFiles("HEAD", []),
      read: (paths) => repository.readFiles("HEAD", paths),
    },
  });
  return {
    ...selected,
    tier,
    matrix,
    files,
    reasons,
    testSelection,
    testShards: testShards(tier, testSelection),
  };
}

/** Answer the plan's Git questions from the repository in `cwd`. */
export const gitRepository = (cwd = process.cwd()) => {
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trimEnd();
  return {
    mergeBase: (base, head) => git("merge-base", base, head),
    isAncestor: (ancestor, head) => {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", ancestor, head], {
          cwd,
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    },
    // Disable rename detection so both the removed and added paths participate.
    changedFiles: (base, head) =>
      git("diff", "--name-only", "--no-renames", "-z", base, head)
        .split("\0")
        .filter(Boolean),
    readFile: (revision, path) => git("show", `${revision}:${path}`),
    listFiles: (revision, directories) =>
      git("ls-tree", "-r", "-z", "--name-only", revision, "--", ...directories)
        .split("\0")
        .filter(Boolean),
    // One batch process reads every requested blob.
    readFiles: (revision, paths) => {
      const output = execFileSync("git", ["cat-file", "--batch"], {
        cwd,
        input: paths.map((path) => `${revision}:${path}\n`).join(""),
        maxBuffer: 512 * 1024 * 1024,
      });
      const contents = new Map();
      let offset = 0;
      for (const path of paths) {
        const end = output.indexOf(10, offset);
        const [, type, size] = output.toString("utf8", offset, end).split(" ");
        if (type !== "blob")
          throw new Error(`Git could not read ${revision}:${path}`);
        const start = end + 1;
        contents.set(
          path,
          output.toString("utf8", start, start + Number(size)),
        );
        offset = start + Number(size) + 1;
      }
      return contents;
    },
  };
};
