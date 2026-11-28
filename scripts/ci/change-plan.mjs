import { execFileSync } from "node:child_process";
import { matchesGlob } from "node:path";
import { isLivingProsePath } from "../lib/docs-facts.mjs";
import { mayGateTestToDarwin } from "./darwin-gate-candidates.mjs";
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
  ".github/workflows/ci-full-pr.yml",
  ".github/workflows/release.yml",
  ".github/workflows/release-recovery.yml",
  ".github/workflows/release-abandon.yml",
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
  "scripts/ci/artifacts.d.mts",
  "scripts/ci/artifacts.mjs",
  "scripts/ci/failure-report.d.mts",
  "scripts/ci/failure-report.mjs",
  "scripts/ci/github-api.d.mts",
  "scripts/ci/github-api.mjs",
  "scripts/ci/job-timings.mjs",
  "scripts/ci/job-timings-batch.mjs",
  "scripts/ci/pr-ci-health.d.mts",
  "scripts/ci/pr-ci-health.mjs",
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
  "scripts/generate-completion-ledger.mjs",
  "scripts/lib/completion-ledger-generation.mts",
  "scripts/generate-error-schema.mjs",
  "scripts/generate-third-party-inventory.mjs",
  "scripts/lib/product-catalog.*",
  "scripts/lib/catalog-core.*",
  "scripts/lib/catalog-cli.*",
];
const matchesAny = (file, patterns) =>
  patterns.some((pattern) => matchesGlob(file, pattern));

const TYPED_LINT_FILE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
// Leave space in the Linux runner's environment for JSON-escaped job outputs
// and the other lane outputs consumed by the required gate.
const TYPED_LINT_OUTPUT_MAX_BYTES = 16 * 1024;

const selectTypedLintFiles = (files, listCheckedOutFiles) => {
  const candidates = files.filter((file) =>
    TYPED_LINT_FILE_EXTENSION.test(file),
  );
  if (!candidates.length) return [];
  // Deletions still affect lane and test selection. Oxlint only takes files
  // tracked in the checkout it will check, and owns its own ignore patterns.
  const checkedOutFiles = new Set(listCheckedOutFiles());
  const selected = candidates.filter((file) => checkedOutFiles.has(file));
  return Buffer.byteLength(JSON.stringify(selected)) <=
    TYPED_LINT_OUTPUT_MAX_BYTES
    ? selected
    : null;
};

/**
 * The first changed test at `head` that may gate a test to macOS. A deleted
 * test has nothing to run.
 */
const changedTestMayGateDarwin = (repository, head, files) => {
  const changedTests = files.filter((file) =>
    /^(src|tests)\/.*\.test\.ts$/u.test(file),
  );
  if (changedTests.length === 0) return undefined;
  const present = new Set(repository.listFiles(head, []));
  const sources = repository.readFiles(
    head,
    changedTests.filter((file) => present.has(file)),
  );
  for (const [file, source] of sources)
    if (mayGateTestToDarwin(source)) return file;
  return undefined;
};

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
    (event === "schedule" && !request.scheduleFast) ||
    event === "workflow_dispatch" ||
    request.full;
  const tier =
    event === "schedule" && request.skipFull && !request.full
      ? "reused"
      : event === "push" && request.pushWarmOnly && !request.full
        ? "warm"
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
    // The documentation check validates living prose and the lockfile inventory.
    if (
      isLivingProsePath(file) ||
      file === "package-lock.json" ||
      file === "website/locales/languages.json"
    )
      selected.docs = true;
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
    // Workflow callers can become invalid when local action inputs or outputs change.
    selected.workflows ||= /^\.github\/actions\/.+\/action\.ya?ml$/u.test(file);
    if (
      file.startsWith(".github/workflows/") ||
      file.startsWith(".github/codeql/") ||
      /^\.github\/actionlint\.ya?ml$/u.test(file)
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
      "Recent exact-SHA qualification reused; no fresh provider observation",
    );
  } else if (tier === "warm") {
    selected.code = true;
    reasons.push(
      "Main push warms shared static and build caches; scheduled fast sweeps verify full suites",
    );
  } else if (tier === "full") {
    full("Full baseline requested by event or ci:full label");
  } else if (
    event === "pull_request" ||
    event === "push" ||
    event === "schedule"
  ) {
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
            baselineReason || "No valid successful baseline was found",
          );
        if (!repository.isAncestor(candidate, head))
          throw new Error("Baseline is not an ancestor");
        base = candidate;
      } catch {
        if (event === "schedule") {
          // A scheduled fast sweep advances the verified schedule baseline.
          // Without a proven ancestor, select every canonical lane rather than
          // only code + runtime so changed providers cannot be skipped.
          for (const flag of flags) selected[flag] = true;
          reasons.push(
            baselineReason ||
              "No valid successful scheduled baseline ancestor; selecting all lanes",
          );
        } else {
          full(
            baselineReason ||
              "No valid successful baseline ancestor; selecting all lanes",
          );
        }
      }
    }
    if (base) {
      // Disable rename detection so both the removed and added paths participate.
      files = repository.changedFiles(base, head);
      for (const file of files) classifyFile(file, base, head);
      // Linux lanes skip a test gated to macOS, so a change to one runs the
      // macOS lane that does.
      const gated = selected.apple
        ? undefined
        : changedTestMayGateDarwin(repository, head, files);
      if (gated !== undefined) {
        selected.apple = true;
        reasons.push(`Changed test may be gated to macOS: ${gated}`);
      }
    }
    // Scheduled fast sweeps always execute the complete portable suite and
    // refresh test-timings-fast, even when only prose changed since the ancestor.
    if (event === "schedule") selected.code = true;
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
  let checkedOutFiles;
  const listCheckedOutFiles = () =>
    (checkedOutFiles ??= repository.listFiles("HEAD", []));
  const testSelection = planTestSelection({
    files,
    event,
    tier,
    code: selected.code,
    // The checked-out revision is the one whose tests run. Script and
    // configuration files are listed so shared script modules can be traced.
    snapshot: {
      list: listCheckedOutFiles,
      read: (paths) => repository.readFiles("HEAD", paths),
    },
  });
  // Linux may skip every module of a selection that may all be gated to
  // macOS; the macOS lane runs each gated module, so the plan selects it.
  if (
    !selected.apple &&
    testSelection.mode === "selected" &&
    testSelection.files.length > 0
  ) {
    const sources = repository.readFiles("HEAD", testSelection.files);
    if (
      testSelection.files.every((file) =>
        mayGateTestToDarwin(sources.get(file) ?? ""),
      )
    ) {
      selected.apple = true;
      reasons.push("Every selected test may be gated to macOS");
    }
  }
  const typedLintFiles =
    event === "pull_request" && tier === "fast" && selected.code
      ? selectTypedLintFiles(files, listCheckedOutFiles)
      : [];
  return {
    ...selected,
    tier,
    matrix,
    files,
    reasons,
    testSelection,
    testShards: testShards(tier, testSelection),
    typedLintFiles,
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
    readFiles: (revision, paths) => {
      if (!paths.length) return new Map();
      const maxBuffer = 512 * 1024 * 1024;
      const objects = new Map();
      // Resolve small changed-test batches directly at their pinned revision.
      // Read symbolic refs once and index the tree for large test graph reads.
      const smallSnapshot =
        paths.length <= 32 && /^[0-9a-f]{40}$/iu.test(revision);
      if (!smallSnapshot) {
        const tree = execFileSync("git", ["ls-tree", "-rz", revision], {
          cwd,
          encoding: "utf8",
          maxBuffer,
        });
        for (const entry of tree.split("\0")) {
          // Let Git resolve replacement characters so invalid UTF-8 bytes
          // cannot alias a requested path when the listing is decoded.
          if (!entry || entry.includes("\uFFFD")) continue;
          // Git separates the header from the raw path at the first tab.
          const tab = entry.indexOf("\t");
          const [, , oid] = entry.slice(0, tab).split(" ");
          objects.set(entry.slice(tab + 1), oid);
        }
      }
      const requests = paths.map(
        (path) => objects.get(path) ?? `${revision}:${path}`,
      );
      const output = execFileSync(
        "git",
        ["cat-file", "--batch", "--buffer", "-z"],
        {
          cwd,
          input: requests.join("\0") + "\0",
          maxBuffer,
        },
      );
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
