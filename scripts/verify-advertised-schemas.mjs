import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  distinctAdvertisedSchemas,
  listAdvertisedCatalogs,
} from "./lib/advertised-catalog.mjs";
import {
  describeSummaryChanges,
  serializeToolSummary,
  summarizeAdvertisedCatalogs,
  toolSummaryFile,
} from "./lib/advertised-catalog-summary.mjs";
import { formatGeneratedFile } from "./lib/format-generated-file.mjs";
import {
  VerifierFixture,
  withVerifierFixture,
} from "./lib/verifier-fixture.mjs";
import { createVerifierCommands } from "./lib/verify-commands.mjs";
import { classifyLaunchFailure } from "../dist/process/launchFailure.js";

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
//
// The run also compares the listings with the committed summary.json, so a
// change to many tools' advertised schemas is visible in review.
// `--update-summary` rewrites it.

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
  else if (option === "--complete" || option === "--update-summary")
    options.add(option);
  else throw new Error(`Unknown advertised schema check option: ${option}`);
const ENGINE_TIMEOUT_MS = 120_000;
// Results carry one entry per refused value, so allow far more than one.
const HELPER_OUTPUT_BYTES = 16 * 1024 * 1024;
const SHOWN_SITES = 3;

/**
 * Run one engine helper under the verifier command owner, which bounds it
 * with a deadline and stops its whole process tree (`go run` starts the
 * compiled program as a child). The request is a file argument; never throws.
 */
const runHelper = async (
  engines,
  { command, args, environment = {} },
  requestPath,
) => {
  try {
    const { stdout } = await commands.exec(command, [...args, requestPath], {
      env: { ...process.env, ...environment },
      timeout: ENGINE_TIMEOUT_MS,
      maxBuffer: HELPER_OUTPUT_BYTES,
    });
    try {
      return JSON.parse(stdout).results;
    } catch (error) {
      return engines.map((engine) => ({
        ...engine,
        broken: `${command} wrote unreadable output: ${String(error)}`,
      }));
    }
  } catch (error) {
    const refusal = classifyLaunchFailure(error);
    if (refusal !== undefined)
      return engines.map((engine) => ({
        ...engine,
        unavailable: `${command} could not start (${refusal.code})`,
      }));
    // A helper that started but failed is a broken check, not a missing
    // engine, so it fails even when engines are optional.
    return engines.map((engine) => ({
      ...engine,
      broken: `${command} failed: ${error instanceof Error ? error.message.trim() : String(error)}`,
    }));
  }
};

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
    patternSites.get(pattern).push(
      ...sites.map((site) => ({
        tool: site.tool,
        text: `${site.tool} ${site.kind} ${path} (${site.profile})`,
      })),
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
    sites: (index) =>
      advertised[index].sites.map((site) => ({
        tool: site.tool,
        text: describeSite(site),
      })),
    describe: (indexes) =>
      `${String(indexes.length)} schema${indexes.length === 1 ? "" : "s"}`,
  },
};
const input = JSON.stringify({
  patterns,
  schemas: advertised.map(({ schema }) => schema),
  complete: options.has("--complete"),
});

const fixture = await VerifierFixture.open({
  prefix: "rea-advertised-schemas-",
});
const commands = await createVerifierCommands();
// The request stays until every helper's process tree is confirmed stopped.
fixture.releaseAfter(() => commands.close());
const results = await withVerifierFixture(fixture, async () => {
  const requestPath = join(fixture.path, "request.json");
  await writeFile(requestPath, input);
  return (
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
          requestPath,
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
          requestPath,
        ),
      ),
    ])
  ).flat();
});

const problems = [];

// Absolute local paths advertise the host's pattern, so the recorded summary
// is the POSIX advertisement; Windows hosts cannot reproduce it. Each tool's
// summary is its own file, so PRs that add different tools do not conflict.
const summaryDirectory = join(directory, "tools");
if (process.platform === "win32")
  console.log("Advertised catalog summary: not compared on Windows hosts.");
else {
  const current = summarizeAdvertisedCatalogs(
    catalogs,
    advertisedSchemaPatterns,
  );
  const recordedFiles = await readdir(summaryDirectory).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const recorded = {};
  const recordedText = new Map();
  for (const file of recordedFiles.filter((name) => name.endsWith(".json"))) {
    const text = await readFile(join(summaryDirectory, file), "utf8");
    recordedText.set(file, text);
    recorded[file.slice(0, -".json".length)] = JSON.parse(text);
  }
  const update = options.has("--update-summary");
  const changes = describeSummaryChanges(recorded, current);
  const expected = new Map(
    await Promise.all(
      Object.entries(current).map(async ([name, summary]) => {
        const file = toolSummaryFile(name);
        return [
          file,
          await formatGeneratedFile(
            join(summaryDirectory, file),
            serializeToolSummary(summary),
          ),
        ];
      }),
    ),
  );
  const stale = [...expected].filter(
    ([file, text]) => recordedText.get(file)?.replaceAll("\r\n", "\n") !== text,
  );
  const removed = [...recordedText.keys()].filter(
    (file) => !expected.has(file),
  );
  if (changes.length > 0)
    console.log(
      `Advertised catalog summary ${update ? "updated" : "differs"}:\n${changes.map((line) => `  ${line}`).join("\n")}`,
    );
  if (update) {
    await mkdir(summaryDirectory, { recursive: true });
    for (const [file, text] of stale)
      await writeFile(join(summaryDirectory, file), text, "utf8");
    for (const file of removed) await rm(join(summaryDirectory, file));
  } else if (stale.length > 0 || removed.length > 0) {
    // Print what each file should hold, so a PR that adds or changes a tool
    // can commit the summary from this output without a local build.
    const relative = (file) =>
      `scripts/verify/advertised-schemas/tools/${file}`;
    const expectedText = stale
      .map(([file, text]) => `--- ${relative(file)}\n${text}`)
      .join("");
    const removedText = removed
      .map((file) => `  delete ${relative(file)}\n`)
      .join("");
    console.log(
      `Expected advertised catalog summary files:\n${expectedText}${removedText}`,
    );
    problems.push(
      `${String(stale.length + removed.length)} advertised catalog summary file(s) are missing or stale. Commit the contents printed above, or run \`npm run verify:advertised-schemas -- --update-summary\`; a PR that changes advertised schemas commits the summary with them.`,
    );
  }
}
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
  // Engines such as the Rust crates name the refusal on the first line and
  // explain it, with the failing schema position, on later lines; the entry
  // keeps the first complete explanation.
  const refusals = new Map();
  for (const { index, error } of result.failures) {
    const [reason, ...explanation] = error.trim().split("\n");
    if (!refusals.has(reason))
      refusals.set(reason, { explanation, indexes: [] });
    refusals.get(reason).indexes.push(index);
  }
  for (const [reason, { explanation, indexes }] of refusals) {
    // Every affected tool, and the first few exact schema locations.
    const where = indexes.flatMap(sites);
    const tools = [...new Set(where.map(({ tool }) => tool))].sort();
    const shown = where
      .slice(0, SHOWN_SITES)
      .map(({ text }) => text)
      .join("; ");
    const more =
      where.length > SHOWN_SITES
        ? ` and ${String(where.length - SHOWN_SITES)} more`
        : "";
    const detail = explanation
      .filter((line) => line.trim() !== "")
      .map((line) => `\n      ${line.trim()}`)
      .join("");
    problems.push(
      `${result.engine} refused ${describe(indexes)}: ${reason}${detail}\n    advertised by ${String(tools.length)} tools: ${tools.join(", ")}\n    at ${shown}${more}`,
    );
  }
}
if (problems.length > 0) {
  console.error(
    `\nAdvertised schema check failed (${String(problems.length)}):\n${problems.map((problem) => `  ${problem}`).join("\n")}`,
  );
  process.exitCode = 1;
}
