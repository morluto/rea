import { execFileSync } from "node:child_process";
import { matchesGlob } from "node:path";
import { pathToFileURL } from "node:url";

/** @type {readonly import("./codeql-scope.d.mts").CodeqlLanguage[]} */
export const CODEQL_LANGUAGES = ["javascript-typescript", "python", "actions"];

// Inputs excluded by .github/codeql/production.yml plus pure prose, assets, and
// source languages outside CodeQL's javascript-typescript/python/actions extractors.
const EXCLUDED_PATTERNS = [
  "tests/**",
  "scripts/fixtures/**",
  "**/*.test.*",
  "**/*.fixture.*",
  "**/test_*.py",
  "**/*_test.py",
  "**/*.md",
  "**/*.mermaid",
  "**/*.csv",
  "licenses/**",
  "LICENSE",
  ".git-blame-ignore-revs",
  "website/locales/**/*.po",
  "website/locales/**/*.pot",
  "**/*.{png,jpg,jpeg,gif,svg,ico,webp}",
  "bridge/**/*.{java,swift}",
  "native/windows/**/*.{cc,cpp,c,h,hpp}",
  "**/*.{go,sol,rs}",
];

const isExcludedFromCodeql = (file) =>
  !file.startsWith("docs/.vitepress/") &&
  EXCLUDED_PATTERNS.some((pattern) => matchesGlob(file, pattern));

const isActionsInput = (file) =>
  /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(file) ||
  /^\.github\/actions\/.+\/action\.ya?ml$/u.test(file);

const isPythonInput = (file) => file.endsWith(".py");

const isJavaScriptTypeScriptInput = (file) =>
  file.startsWith("docs/.vitepress/") ||
  file === ".npmrc" ||
  file === ".nvmrc" ||
  /\.(?:[cm]?[jt]s|[jt]sx|html?|xhtml|vue|jsonc?)$/u.test(file);

/**
 * Select the CodeQL languages required for one event. Non-PR baselines and any
 * unrecognized or scan-configuration inputs select all configured languages.
 *
 * @param {import("./codeql-scope.d.mts").CodeqlScopeRequest} request
 * @param {import("./codeql-scope.d.mts").CodeqlScopeRepository} repository
 * @returns {import("./codeql-scope.d.mts").CodeqlScopePlan}
 */
export function planCodeqlLanguages(request, repository) {
  if (request.event !== "pull_request") {
    return {
      run: true,
      languages: [...CODEQL_LANGUAGES],
      reason: `Complete CodeQL baseline for ${request.event ?? "unknown"} event`,
    };
  }
  const { base, head } = request;
  if (
    !base ||
    !head ||
    !/^[0-9a-f]{40}$/iu.test(base) ||
    !/^[0-9a-f]{40}$/iu.test(head)
  ) {
    return {
      run: true,
      languages: [...CODEQL_LANGUAGES],
      reason: "Missing or invalid pull-request revision; running all languages",
    };
  }
  let files;
  try {
    const mergeBase = repository.mergeBase(base, head);
    files = repository.changedFiles(mergeBase, head);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      run: true,
      languages: [...CODEQL_LANGUAGES],
      reason: `Git diff failed (${message}); running all languages`,
    };
  }

  /** @type {Set<import("./codeql-scope.d.mts").CodeqlLanguage>} */
  const selected = new Set();
  for (const file of files) {
    if (
      file.startsWith(".github/codeql/") ||
      file === ".github/workflows/codeql.yml"
    ) {
      return {
        run: true,
        languages: [...CODEQL_LANGUAGES],
        reason: `CodeQL configuration changed: ${file}`,
      };
    }
    if (isExcludedFromCodeql(file)) continue;
    let matched = false;
    if (isActionsInput(file)) {
      selected.add("actions");
      matched = true;
    }
    if (isPythonInput(file)) {
      selected.add("python");
      matched = true;
    }
    if (isJavaScriptTypeScriptInput(file)) {
      selected.add("javascript-typescript");
      matched = true;
    }
    if (!matched) {
      return {
        run: true,
        languages: [...CODEQL_LANGUAGES],
        reason: `Unclassified input selects all CodeQL languages: ${file}`,
      };
    }
  }
  const languages = CODEQL_LANGUAGES.filter((language) =>
    selected.has(language),
  );
  return {
    run: languages.length > 0,
    languages,
    reason:
      languages.length > 0
        ? `Selected CodeQL languages: ${languages.join(", ")}`
        : "No CodeQL-extracted production files changed",
  };
}

function gitCodeqlRepository(cwd = process.cwd()) {
  const git = (args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  return {
    mergeBase: (base, head) => git(["merge-base", base, head]).trim(),
    changedFiles: (base, head) =>
      git(["diff", "--name-only", "-z", "--no-renames", `${base}..${head}`])
        .split("\0")
        .filter(Boolean),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const plan = planCodeqlLanguages(
    {
      event: process.env.GITHUB_EVENT_NAME,
      base: process.env.BASE_SHA,
      head: process.env.HEAD_SHA,
    },
    gitCodeqlRepository(),
  );
  process.stderr.write(`CodeQL language selection: ${plan.reason}\n`);
  process.stdout.write(
    `run=${String(plan.run)}\nlanguages=${JSON.stringify(plan.languages)}\n`,
  );
}
