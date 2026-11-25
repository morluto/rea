import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  compareCountedBaseline,
  reconcileBaselineFile,
} from "./counted-baseline.mjs";
import {
  authoredOnlyRefusalCount,
  fixedCeilingDeclarations,
} from "./fixed-ceiling-guard.mjs";

// Every fixed ceiling a refusal declares (`fixedAllowanceOptions`,
// `fixedProducerInputAllowance`, `artifactFixedLimitFailure` or an inline
// `fixedAllowance: { ... }`) must be listed in fixed-ceiling-registry.json
// under its file and allowance text, with the reason it cannot be adjusted:
//
// - `format`: a format or specification fact (a field width, a spec maximum).
// - `protocol`: a transport or protocol frame REA does not own.
// - `representation`: an exact runtime representation bound.
// - `derived`: grows with the admitted input or another named control.
// - `forwarding`: relays a ceiling declared at another site.
// - `pending`: a resource limit that should become adjustable; it names the
//   issue that tracks giving it a control.
//
// A resource or admission limit (bytes read, rows, nesting, worker heap,
// expansion, index allowances) is not a fixed ceiling: give it a setting or
// per-call parameter and report `details.limit` instead
// (docs/reference/limits-and-recovery.md). An entry whose declaration is gone
// is stale and fails, so the registry cannot hide a removed ceiling.
//
// The same scan counts refusals whose only recovery is an authored
// `remediationAction` (no `limit`, `fixedAllowance` or `measuredExhaustion`)
// against a shrink-only per-file baseline (#14234). Both checks parse
// TypeScript, so they run from `npm run lint` after dependencies are
// installed rather than from the dependency-free architecture guards.

const root = fileURLToPath(new URL("../../", import.meta.url));
const registryPath = join(root, "scripts/verify/fixed-ceiling-registry.json");
const BASELINE = "scripts/verify/untyped-budget-refusal-baseline.json";

/** Classes that may justify a fixed ceiling, plus `pending`. */
export const FIXED_CEILING_CLASSES = new Set([
  "format",
  "protocol",
  "representation",
  "derived",
  "forwarding",
  "pending",
]);

const sourceFiles = async (dir) => {
  const output = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...(await sourceFiles(path)));
    else if (
      entry.name.endsWith(".ts") &&
      !/\.(?:test|spec|fixture)\.ts$/u.test(entry.name)
    )
      output.push(path);
  }
  return output;
};

/**
 * Compare declarations with the registry. Returns failure lines.
 *
 * @param {ReadonlyMap<string, ReadonlyMap<string, number>>} declarations path to allowance text to line
 * @param {Record<string, Record<string, { class?: unknown, reason?: unknown, issue?: unknown }>>} registry
 * @returns {string[]}
 */
export const compareFixedCeilings = (declarations, registry) => {
  const failures = [];
  for (const [path, found] of declarations)
    for (const [allowance, line] of found) {
      const entry = registry[path]?.[allowance];
      if (entry === undefined) {
        failures.push(
          `${path}:${String(line)} declares fixed ceiling ${allowance}, which is not in scripts/verify/fixed-ceiling-registry.json. Give a resource limit a setting or per-call parameter and report details.limit; register a format, protocol, representation, derived or forwarding ceiling with its reason, or a pending one with its issue.`,
        );
        continue;
      }
      if (!FIXED_CEILING_CLASSES.has(entry.class))
        failures.push(
          `${path}: ${allowance} has class ${JSON.stringify(entry.class)}; use one of ${[...FIXED_CEILING_CLASSES].join(", ")}.`,
        );
      if (typeof entry.reason !== "string" || entry.reason.trim() === "")
        failures.push(`${path}: ${allowance} states no reason.`);
      if (entry.class === "pending" && !Number.isSafeInteger(entry.issue))
        failures.push(
          `${path}: pending ceiling ${allowance} names no tracking issue.`,
        );
      if (entry.class !== "pending" && entry.issue !== undefined)
        failures.push(
          `${path}: ${allowance} is ${String(entry.class)} and cannot name a pending issue.`,
        );
    }
  for (const [path, entries] of Object.entries(registry))
    for (const allowance of Object.keys(entries))
      if (!declarations.get(path)?.has(allowance))
        failures.push(
          `scripts/verify/fixed-ceiling-registry.json lists ${path}: ${allowance}, which no longer declares a fixed ceiling; remove the stale entry.`,
        );
  return failures;
};

/**
 * Compare authored-only refusal counts with their shrink-only baseline.
 * Returns failure lines and the baseline after any shrinking.
 *
 * @param {ReadonlyMap<string, number>} counts
 * @param {Record<string, number>} baseline
 * @param {boolean} shrink
 * @returns {{ failures: string[], baseline: Record<string, number> }}
 */
export const compareAuthoredOnlyRefusals = (counts, baseline, shrink) => {
  const compared = compareCountedBaseline(counts, baseline, shrink);
  const lines = (differences) =>
    differences
      .map(
        ({ path, count, allowed }) =>
          `  ${path}: ${String(count)} (baseline ${String(allowed)})`,
      )
      .join("\n");
  const failures = [];
  if (compared.grown.length > 0)
    failures.push(
      `Budget refusal with only authored recovery; bind \`limit\` to its setting or per-call parameter, use a registered fixedAllowanceOptions ceiling, or declare measuredExhaustion (#14234):\n${lines(compared.grown)}`,
    );
  if (compared.stale.length > 0)
    failures.push(
      `Authored-only refusals were removed; lower ${BASELINE} with \`node scripts/verify/fixed-ceilings.mjs --shrink-baselines\`:\n${lines(compared.stale)}`,
    );
  return { failures, baseline: compared.baseline };
};

/** The baseline file's text, or undefined once its last count was removed. */
const readBaselineText = async (path) => {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  }
};

/**
 * Compare the authored-only counts with the baseline file at `path` and, when
 * shrinking, rewrite it or delete it once no count remains. An absent file is
 * an empty baseline. Returns failure lines.
 *
 * @param {string} path
 * @param {ReadonlyMap<string, number>} counts
 * @param {boolean} shrink
 * @returns {Promise<string[]>}
 */
export const checkAuthoredOnlyBaseline = async (path, counts, shrink) => {
  const text = await readBaselineText(path);
  const refusals = compareAuthoredOnlyRefusals(
    counts,
    text === undefined ? {} : JSON.parse(text),
    shrink,
  );
  const failures = [...refusals.failures];
  const file = reconcileBaselineFile(text, refusals.baseline, shrink);
  if (file.action === "write") await writeFile(path, file.text);
  else if (file.action === "delete") await rm(path);
  else if (file.action === "reject")
    failures.push(
      `${BASELINE} is not in its written form (paths sorted by code unit), or has no counts left; rewrite or remove it with \`node scripts/verify/fixed-ceilings.mjs --shrink-baselines\`.`,
    );
  return failures;
};

const main = async () => {
  const declarations = new Map();
  const authored = new Map();
  for (const file of await sourceFiles(join(root, "src"))) {
    const path = relative(root, file).split(sep).join("/");
    const content = await readFile(file, "utf8");
    const found = fixedCeilingDeclarations(content, path);
    if (found.size > 0) declarations.set(path, found);
    const count = authoredOnlyRefusalCount(content, path);
    if (count > 0) authored.set(path, count);
  }
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const failures = compareFixedCeilings(declarations, registry);
  failures.push(
    ...(await checkAuthoredOnlyBaseline(
      join(root, BASELINE),
      authored,
      process.argv.includes("--shrink-baselines"),
    )),
  );
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
    return;
  }
  let pending = 0;
  for (const entries of Object.values(registry))
    for (const entry of Object.values(entries))
      if (entry.class === "pending") pending++;
  console.log(
    `Fixed ceilings: ${String([...declarations.values()].reduce((sum, found) => sum + found.size, 0))} declarations registered; ${String(pending)} pending a control. Authored-only refusals: ${String([...authored.values()].reduce((sum, count) => sum + count, 0))}.`,
  );
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
