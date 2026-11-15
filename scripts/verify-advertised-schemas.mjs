import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  distinctAdvertisedSchemas,
  listAdvertisedCatalogs,
} from "./lib/advertised-catalog.mjs";

// Compile every regular expression and schema the packaged server advertises,
// in every schema profile, with the engines and validators clients and
// gateways actually run. One pattern or schema an engine refuses can make a
// client reject the whole tools/list (#10830), so the portable-dialect rules
// are not trusted on their own.
//
// An engine that is not installed is reported as not verified. CI sets
// REA_REQUIRE_SCHEMA_ENGINES=1, which turns a missing engine into a failure.
// `--package-root=DIR` lists an installed package, such as a packed release
// candidate, instead of this checkout's build.
// `--complete` adds the Python `jsonschema` meta-validation, which takes
// seconds per profile.

const directory = join(
  dirname(fileURLToPath(import.meta.url)),
  "verify/advertised-schemas",
);
const required = process.env.REA_REQUIRE_SCHEMA_ENGINES === "1";
const options = new Set();
let packageRoot;
for (const option of process.argv.slice(2))
  if (option.startsWith("--package-root="))
    packageRoot = resolve(option.slice("--package-root=".length));
  else if (option === "--complete") options.add(option);
  else throw new Error(`Unknown advertised schema check option: ${option}`);
const ENGINE_TIMEOUT_MS = 120_000;
const SHOWN_SITES = 3;

/** Run one engine helper with its request on stdin; never throws. */
const runHelper = (engines, { command, args, environment = {} }, input) =>
  new Promise((resolve) => {
    const unavailable = (reason) =>
      resolve(engines.map((engine) => ({ ...engine, unavailable: reason })));
    const child = spawn(command, args, {
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), ENGINE_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      unavailable(`${command} could not start: ${error.message}`);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        // A helper that started but failed is a broken check, not a missing
        // engine, so it fails even when engines are optional.
        resolve(
          engines.map((engine) => ({
            ...engine,
            broken: `${command} exited with ${signal ?? code}: ${stderr.trim()}`,
          })),
        );
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")).results);
      } catch (error) {
        resolve(
          engines.map((engine) => ({
            ...engine,
            broken: `${command} wrote unreadable output: ${String(error)}`,
          })),
        );
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });

const timed = async (run) => {
  const start = performance.now();
  const results = await run();
  const elapsed = Math.round(performance.now() - start);
  // Helpers that check several engines time each one themselves.
  return results.map((result) => ({ elapsed, ...result }));
};

/** V8 in this process, in the modes JavaScript clients compile with. */
const v8Results = (patterns) =>
  ["", "u", "v"].map((flags) => {
    const start = performance.now();
    const failures = [];
    patterns.forEach((pattern, index) => {
      try {
        new RegExp(pattern, flags);
      } catch (error) {
        failures.push({ index, error: String(error) });
      }
    });
    return {
      engine: `v8 /${flags}`,
      kind: "pattern",
      version: process.versions.v8,
      elapsed: Math.round(performance.now() - start),
      failures,
    };
  });

const start = performance.now();
const catalogs = await listAdvertisedCatalogs(packageRoot);
const listed = Math.round(performance.now() - start);
const { advertisedSchemaPatterns } =
  await import("../dist/contracts/advertisedDialect.js");

// Each distinct schema and pattern once, with every place it is advertised.
const describeSite = (site) => `${site.tool} ${site.kind} (${site.profile})`;
const advertised = distinctAdvertisedSchemas(catalogs);
const patternSites = new Map();
for (const { schema, sites } of advertised)
  for (const { path, pattern } of advertisedSchemaPatterns(schema)) {
    if (!patternSites.has(pattern)) patternSites.set(pattern, []);
    patternSites
      .get(pattern)
      .push(
        ...sites.map(
          (site) => `${site.tool} ${site.kind} ${path} (${site.profile})`,
        ),
      );
  }
const patterns = [...patternSites.keys()];
if (patterns.length === 0)
  throw new Error("The packaged catalog advertised no patterns to check");
const checked = {
  pattern: {
    values: patterns,
    sites: (index) => patternSites.get(patterns[index]),
    describe: (indexes) =>
      indexes.map((index) => `/${patterns[index]}/`).join(", "),
  },
  schema: {
    values: advertised,
    sites: (index) => advertised[index].sites.map(describeSite),
    describe: (indexes) =>
      `${String(indexes.length)} schema${indexes.length === 1 ? "" : "s"}`,
  },
};
const input = JSON.stringify({
  patterns,
  schemas: advertised.map(({ schema }) => schema),
  complete: options.has("--complete"),
});

const results = (
  await Promise.all([
    timed(async () => v8Results(patterns)),
    timed(() =>
      runHelper(
        [{ engine: "go regexp (RE2)", kind: "pattern" }],
        {
          command: "go",
          args: ["run", join(directory, "regexp.go")],
          // Use the installed toolchain; never download another one.
          environment: { GOTOOLCHAIN: "local", GOFLAGS: "" },
        },
        input,
      ),
    ),
    timed(() =>
      runHelper(
        [
          { engine: "python re", kind: "pattern" },
          { engine: "re2 (C++)", kind: "pattern" },
          { engine: "rust regex", kind: "pattern" },
          { engine: "rust fancy-regex", kind: "pattern" },
          { engine: "rust jsonschema", kind: "schema" },
          ...(options.has("--complete")
            ? [{ engine: "python jsonschema", kind: "schema" }]
            : []),
        ],
        {
          command:
            process.env.REA_SCHEMA_ENGINES_PYTHON ??
            (process.platform === "win32" ? "python" : "python3"),
          args: ["-I", join(directory, "engines.py")],
        },
        input,
      ),
    ),
  ])
).flat();

const problems = [];
console.log(
  `Listed ${String(catalogs.length)} packaged catalogs in ${String(listed)} ms: ${String(advertised.length)} distinct schemas, ${String(patterns.length)} distinct patterns.`,
);
for (const result of results) {
  if (result.unavailable !== undefined) {
    console.log(`- ${result.engine}: not verified (${result.unavailable})`);
    if (required)
      problems.push(`${result.engine} is required but ${result.unavailable}`);
    continue;
  }
  if (result.broken !== undefined) {
    console.log(`- ${result.engine}: check failed (${result.broken})`);
    problems.push(`${result.engine} check failed: ${result.broken}`);
    continue;
  }
  const { values, sites, describe } = checked[result.kind];
  console.log(
    `- ${result.engine} ${result.version}: ${String(values.length - result.failures.length)}/${String(values.length)} ${result.kind}s accepted (${String(result.elapsed)} ms)`,
  );
  // One entry per distinct refusal: a shared pattern fails many schemas.
  const refusals = new Map();
  for (const { index, error } of result.failures) {
    // Engines such as the Rust crates explain on later lines; the first names it.
    const reason = error.trim().split("\n")[0];
    if (!refusals.has(reason)) refusals.set(reason, []);
    refusals.get(reason).push(index);
  }
  for (const [reason, indexes] of refusals) {
    const where = indexes.flatMap(sites);
    const shown = where.slice(0, SHOWN_SITES).join("; ");
    const more =
      where.length > SHOWN_SITES
        ? ` and ${String(where.length - SHOWN_SITES)} more`
        : "";
    problems.push(
      `${result.engine} refused ${describe(indexes)}: ${reason}\n    advertised at ${shown}${more}`,
    );
  }
}
if (problems.length > 0) {
  console.error(
    `\nAdvertised schema check failed (${String(problems.length)}):\n${problems.map((problem) => `  ${problem}`).join("\n")}`,
  );
  process.exitCode = 1;
}
