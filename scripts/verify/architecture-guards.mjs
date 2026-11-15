import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { recordPredicateCounts } from "./record-predicate-guard.mjs";
import {
  compareCountedBaseline,
  recordLoweredBaseline,
} from "./counted-baseline.mjs";
import { countKeyedFirstMatches } from "./keyed-first-match.mjs";

// Architecture guards for the strict-identity / best-effort-inference split.
// - Composite dedup keys must not NUL-join variable-length or free-form
//   MIDDLE fields: ["a\0b"] collapses with ["a", "b"] and drops a finding.
//   The text check below only flags one spelling; it is not a complete audit.
// - Transparent wrappers unwrap in exactly one place
//   (javascriptAstValues.unwrapJavaScriptExpression); direct isTS* unwrapping
//   elsewhere drifts (the `satisfies` class of bug).

const root = fileURLToPath(new URL("../../", import.meta.url));

const listFiles = async (dir) => {
  const output = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...(await listFiles(path)));
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".spec.ts") &&
      !entry.name.endsWith(".fixture.ts")
    )
      output.push(path);
  }
  return output;
};

const stripComments = (content) =>
  content
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//gu, "");

const sources = await listFiles(join(root, "src"));
const files = await Promise.all(
  sources.map(async (path) => ({
    path: relative(root, path).split(sep).join("/"),
    content: stripComments(await readFile(path, "utf8")),
  })),
);
const failures = [];
const check = (label, selected, pattern, allow = []) => {
  const offenders = selected.filter(
    (file) => pattern.test(file.content) && !allow.includes(file.path),
  );
  if (offenders.length > 0)
    failures.push(
      `${label}:\n${offenders.map((file) => `  ${file.path}`).join("\n")}`,
    );
};

// Prerequisite inspection lifetime is an application contract shared by adapters.
check(
  "provider-owned inspection lifetime (use src/application/ProviderInspectionScope)",
  files,
  /providers\/ProviderInspectionScope\.js/,
);

check("NUL-joined list key (use compositeKey)", files, /\.join\(["']\\0["']\)/);

check(
  "direct transparent-wrapper unwrap outside javascriptAstValues (use unwrapJavaScriptExpression)",
  files,
  /isTSAsExpression|isTSSatisfiesExpression|isTSNonNullExpression|isTSTypeAssertion|isTSInstantiationExpression|isParenthesizedExpression/,
  ["src/domain/javascript/javascriptAstValues.ts"],
);

// A producer that pins both the soft and hard ceiling of every resource takes
// the vector from one owner. prlimitCeilingArguments is the command-less prefix
// of prlimitArgumentVector; both live in src/process/LinuxResourceLimits.ts.
// Re-audited 2026-10-22 with util-linux 2.39.3: a bare value sets both soft and
// hard, the same as soft:hard when the numbers are equal. `soft:` leaves the
// inherited hard ceiling unchanged.
// FirmwareCommand and WakaruCommand call prlimitArgumentVector and keep their
// own file-size and CPU budgets (120 CPU seconds; firmware file size is the
// call output budget or the 8 MiB report allowance; Wakaru file size is the
// 128 MiB output allowance). Their 1 GiB address space is
// BOUNDED_PRODUCER_LIMITS.address_space_bytes. PcapNativeBound calls
// prlimitCeilingArguments because PcapCommand appends the producer command.
// Its CPU ceiling stays 300 seconds and it has no resident-input budget;
// address space and file size use those shared fields.
// selectEvmWorkerLimits stays a separate selector: Result failures, unit
// checks, and a refusal when soft exceeds hard. It must not call
// clampLinuxResourceLimits.
check(
  "inline paired prlimit ceilings (use prlimitArgumentVector from src/process/LinuxResourceLimits)",
  files,
  /--core=0:0/,
  ["src/process/LinuxResourceLimits.ts"],
);

check(
  "bare prlimit value (a bare value sets both ceilings; use prlimitArgumentVector)",
  files,
  /--core=0(?!:)/,
);

// 2026-10-22: soft-only `resource:` options retain the inherited hard ceiling.
// EVMole budgets differ (3 GiB address space, 16 MiB file, 30 CPU seconds), so
// this lane must not call prlimitArgumentVector.
check(
  "soft-only prlimit ceilings (paired producers use prlimitArgumentVector)",
  files,
  /--core=0:(?!0)/,
  ["src/evm/EvmoleInterfaceProvider.ts"],
);

// Resident input is the input_bytes field of BOUNDED_PRODUCER_LIMITS. CamelCase
// inputBytes values with a different policy (an overridable pwntools admission,
// historical capture intake) are not this budget.
check(
  "inline resident-input budget (use BOUNDED_PRODUCER_LIMITS from src/domain/producerResourceLimits)",
  files,
  /input_bytes:\s*32 \* 1024 \* 1024/,
  ["src/domain/producerResourceLimits.ts"],
);

// Fixed-arity backtick keys audited 2026-10-10: every prefix field is NUL-free
// (hex digests, file paths, enums, numbers, or compositeKey JSON which escapes
// NUL), with free-form source strings only in final position. New backtick-\0
// keys must either meet that shape (and extend this list with justification)
// or use compositeKey.
check(
  "new backtick-NUL composite key (audit against the rule above)",
  files,
  /`[^`\n]*\\0/,
  [
    // Bundle fingerprint: fixed packaged paths (no NUL/newline) and 64 hex
    // digest characters per record, never guide contents. Preserve v1 locators.
    "src/application/GuidanceAccess.ts",
    "src/application/javascript/ElectronBoundaryAnalysis.ts",
    "src/application/javascript/ElectronBoundaryGraphContext.ts",
    "src/browser/CdpCaptureCompleteness.ts",
    "src/browser/CdpCaptureEventHandlers.ts",
    "src/browser/CdpPageCapture.ts",
    "src/browser/WebSourceMapFetcher.ts",
    "src/domain/javascript/electronStaticAnalysisBrowser.ts",
    "src/domain/javascript/electronStaticAnalysisIpc.ts",
    "src/domain/javascript/javascriptApplicationChangeGraph.ts",
    "src/domain/javascript/javascriptApplicationVersionItems.ts",
    "src/domain/javascript/javascriptApplicationVersionKeys.ts",
    "src/domain/javascript/javascriptExportShapeSelection.ts",
    "src/domain/javascript/javascriptFeatureSeed.ts",
    "src/domain/javascript/javascriptFeatureTraversal.ts",
    "src/domain/javascript/javascriptNativeHandoff.ts",
    "src/domain/javascript/javascriptRuntimeReconciliationMatching.ts",
    "src/domain/javascript/javascriptRuntimeReconciliationSchemas.ts",
    "src/domain/javascript/javascriptStaticAnalysisBundler.ts",
    "src/domain/javascript/javascriptStaticAnalysisCalls.ts",
    "src/domain/javascript/javascriptStaticAnalysisFindings.ts",
    "src/domain/localPath.ts",
    "src/domain/process/processTraceEvaluation.ts",
    "src/domain/process/processTraceSpecification.ts",
    "src/domain/unicodeCodePointOrder.ts",
    "src/domain/webBundleAnalyzerInspection.ts",
  ],
);

// "Non-null object other than an array" has one owner: src/domain/isRecord.ts.
// A local predicate with that body, under any name, is a copy. The listed files
// still hold one and may only be removed from the list; a listed file that no
// longer matches fails so the list shrinks with the code.
const RECORD_PREDICATE_COPIES = [
  // Exported under a module-specific name; importers still use that name.
  "src/browser/history/CaptureRedaction.ts",
  "src/contracts/compactJsonSchema.ts",
  "src/domain/analysisView/environmentStateRules.ts",
  // Owned by the advertised-schema workstream.
  "src/contracts/inputSchemaPresentation.ts",
  // Narrows a protocol-specific parameter type, not unknown.
  "src/browser/execution/CdpRuntimeInitiator.ts",
  // Named `object`, which also spells the typeof result in these files.
  "src/pcap/PcapDnsWire.ts",
  "src/pcap/PcapOutput.ts",
];
const mismatchedRecordCopies = files.filter(({ path, content }) => {
  if (path === "src/domain/isRecord.ts") return false;
  const { named, bodies } = recordPredicateCounts(content);
  return (
    named !== 0 || bodies !== (RECORD_PREDICATE_COPIES.includes(path) ? 1 : 0)
  );
});
const pathsWithRecordCopies = new Set(files.map(({ path }) => path));
const missingRecordCopies = RECORD_PREDICATE_COPIES.filter(
  (path) => !pathsWithRecordCopies.has(path),
);
if (mismatchedRecordCopies.length > 0)
  failures.push(
    `local non-array record predicate count changed (import isRecord and update the baseline):\n${mismatchedRecordCopies.map(({ path }) => `  ${path}`).join("\n")}`,
  );
if (missingRecordCopies.length > 0)
  failures.push(
    `record predicate baseline references missing files; remove those entries:\n${missingRecordCopies.map((path) => `  ${path}`).join("\n")}`,
  );

// Node clamps a timer delay above the signed 32-bit bound to 1 ms. Durations
// use MAX_NODE_TIMER_DELAY_MS or timerDurationMsSchema from their one owner.
// The allowed files bound signed 32-bit integers that are not timer delays.
check(
  "signed 32-bit bound literal (use MAX_NODE_TIMER_DELAY_MS or timerDurationMsSchema from src/domain/analysisResourceLimits for durations)",
  files,
  /\b2_?147_?483_?647\b/u,
  [
    "src/domain/analysisResourceLimits.ts",
    // JADX MCP `limit` argument: a Java int, not a duration.
    "src/android/JadxAnalysis.ts",
    // JVM `-XX:ActiveProcessorCount`: a Java int processor count.
    "src/android/JadxConfiguration.ts",
    // TShark `-c` packet count: a C int, not a duration.
    "src/domain/captures/packetCapture.ts",
    // DEX static `int` value range.
    "src/domain/android/androidAnalysis.ts",
    // Signed 32-bit bitmask operand range.
    "src/domain/javascript/javascriptSemanticResources.ts",
    // Recorded crash pid, signal number and code fields.
    "src/domain/native/recordedCrash.ts",
    // Java int parsing for Ghidra launch properties.
    "src/ghidra/GhidraInstallationPolicy.ts",
  ],
);

// Native inventory results parse once against their named fact contract
// (docs/adr/native/typed-operation-facts.md). Hopper's reply table and the
// advertised output schemas own their own protocol and catalog contracts.
check(
  "native inventory rows parsed outside their fact contract (use executeFact or a contract from src/domain/native/nativeOperationFacts)",
  files,
  /\bnativeInventoryRowsSchemas\b|z\.array\(\s*addressedValueSchema\b|\baddressedValueSchema\s*\.\s*(?:safeParse|parse|pick)\b/,
  [
    "src/domain/native/nativeInventory.ts",
    "src/domain/native/nativeOperationFacts.ts",
    "src/hopper/HopperReplyContracts.ts",
    "src/contracts/toolOutputSchemaGroups.ts",
  ],
);

// Mach-O load-command codes have one table; a local copy drifts from it.
check(
  "local Mach-O load-command code (import LC from src/domain/apple/machoLoadCommandCodes)",
  files,
  /\bLC_[A-Z0-9_]+\s*=\s*(?:0x[0-9a-f]+|\d+)\b/iu,
  ["src/domain/apple/machoLoadCommandCodes.ts"],
);

// Counted baselines record the remaining copies of a pattern that has one
// owner. A file may not gain copies and a baseline may not grow; when copies
// are removed, `--shrink-baselines` lowers the recorded counts (and never
// raises them) so the next removal cannot be undone silently.
const baselinePath = join(
  root,
  "scripts/verify/architecture-guard-baselines.json",
);
const baselines = JSON.parse(await readFile(baselinePath, "utf8"));
const shrinkBaselines = process.argv.includes("--shrink-baselines");
let baselinesShrunk = false;
const checkCounted = (label, key, selected, pattern, owners) => {
  const counts = new Map();
  for (const file of selected) {
    if (owners.includes(file.path)) continue;
    const count =
      typeof pattern === "function"
        ? pattern(file.content)
        : (file.content.match(pattern)?.length ?? 0);
    if (count > 0) counts.set(file.path, count);
  }
  const compared = compareCountedBaseline(
    counts,
    baselines[key] ?? {},
    shrinkBaselines,
  );
  const lines = (differences) =>
    differences
      .map(
        ({ path, count, allowed }) =>
          `  ${path}: ${count} (baseline ${allowed})`,
      )
      .join("\n");
  if (compared.grown.length > 0)
    failures.push(
      `${label}; new copies are not allowed:\n${lines(compared.grown)}`,
    );
  if (recordLoweredBaseline(baselines, key, compared)) baselinesShrunk = true;
  if (compared.stale.length > 0)
    failures.push(
      `${label}; copies were removed, so lower the baseline with \`node scripts/verify/architecture-guards.mjs --shrink-baselines\`:\n${lines(compared.stale)}`,
    );
};

// Cancellation reasons are required by `cancelledBy` in analysisErrorCore; a
// direct construction can omit or replace the caller's reason.
checkCounted(
  "direct AnalysisCancelledError construction (use cancelledBy from src/domain/analysisErrorCore)",
  "analysis-cancelled-constructor",
  files,
  /new AnalysisCancelledError\(/gu,
  ["src/domain/analysisErrorCore.ts"],
);

// A deadline is a monotonic budget owned by `Deadline` in src/domain/deadline;
// a wall-clock sum moves with clock changes and has no finalize phase. The
// remaining copy converts a monotonic budget for a browser page, which can
// only read its own wall clock.
checkCounted(
  "wall-clock deadline computation (use Deadline from src/domain/deadline)",
  "wall-clock-deadline",
  files,
  /Date\.now\(\)\s*\+/gu,
  [],
);

// `tshark -T json` has one envelope reader, src/pcap/TsharkJsonPackets.ts,
// which owns malformed JSON, the packet array and each packet's layers.
checkCounted(
  "local tshark JSON envelope read (use parseTsharkJsonPackets or readTsharkJsonPackets from src/pcap/TsharkJsonPackets)",
  "tshark-json-envelope",
  files,
  /\b_source\s*\.\s*layers\b/gu,
  ["src/pcap/TsharkJsonPackets.ts"],
);

// GDB MI result records have one parser, src/gdb/GdbMiRecord.ts, which
// returns typed records and typed failures. A regex over `\^done` accepts a
// malformed record by its prefix.
checkCounted(
  "GDB MI result record regex (use parseGdbMiResultRecord or parseGdbMiDoneRecord from src/gdb/GdbMiRecord)",
  "gdb-mi-record-regex",
  files,
  /\\\^\(?(?:\?:)?(?:done|running|connected|error|exit)\b/gu,
  ["src/gdb/GdbMiRecord.ts"],
);

// Byte-format parsers read untrusted input. Bounds, truncation and failure
// kind belong to BinaryReader (src/native/metadata/BinaryContainer.ts) and
// the ParseFailure algebra (src/domain/parseFailure.ts), not to each parser.
const PARSER_FOLDERS = [
  "src/android/",
  "src/apkSignature/",
  "src/artifacts/",
  "src/dotnet/",
  "src/electron/",
  "src/erlang/",
  "src/evm/",
  "src/firmware/",
  "src/flutter/",
  "src/go/",
  "src/gpu/",
  "src/il2cpp/",
  "src/model/",
  "src/native/",
  "src/python/",
  "src/rust/",
  "src/v8/",
  "src/wasm/",
  ...[
    "android",
    "apkSignature",
    "apple",
    "electron",
    "erlang",
    "evm",
    "firmware",
    "flutter",
    "go",
    "gpu",
    "il2cpp",
    "managed",
    "model",
    "native",
    "python",
    "rust",
    "v8",
    "wasm",
    "windows",
  ].map((folder) => `src/domain/${folder}/`),
];
const parserFiles = files.filter((file) =>
  PARSER_FOLDERS.some((folder) => file.path.startsWith(folder)),
);

// An unchecked Buffer or DataView read throws a bare RangeError past the end,
// which a catch site cannot tell from a host stack or string limit.
checkCounted(
  "raw Buffer or DataView numeric read (use BinaryReader from src/native/metadata/BinaryContainer)",
  "raw-buffer-read",
  files,
  /\.(?:read(?:Big)?U?Int(?:8|16|32|64)?(?:LE|BE)?|readBigUint64(?:LE|BE)|readUint(?:8|16|32)(?:LE|BE)?|read(?:Float|Double)(?:LE|BE)|get(?:Big)?(?:Uint|Int)(?:8|16|32|64)|getFloat(?:32|64))\(/gu,
  ["src/native/metadata/BinaryContainer.ts"],
);

checkCounted(
  "plain Error, TypeError or RangeError thrown by a parser (throw a ParseFailureError from src/domain/parseFailure)",
  "parser-plain-throw",
  parserFiles,
  /throw new (?:Error|TypeError|RangeError)\(/gu,
  [],
);

// A per-format failure class restates the ParseFailure algebra under its own
// spelling and needs its own catch-site translation; parsers throw a
// ParseFailureError (or a subclass of it) instead.
checkCounted(
  "per-format failure class extending Error (throw a ParseFailureError from src/domain/parseFailure)",
  "parser-format-failure-class",
  files,
  /class \w*(?:Format|Parse)(?:Failure|Error) extends Error\b/gu,
  ["src/domain/parseFailure.ts"],
);

// JSON.parse keeps the last of repeated member names without saying so; a
// parser of artifact content must state its duplicate-member policy
// (src/domain/jsonDuplicateMember.ts finds a repeated name).
checkCounted(
  "plain JSON.parse of parser input (state the duplicate-member policy; see src/domain/jsonDuplicateMember)",
  "parser-json-parse",
  parserFiles,
  /JSON\.parse\(/gu,
  [],
);

// A RangeError can mean a stack overflow, a host string or buffer limit, a
// raw read or write past a buffer, or whatever its thrower intended. Only
// known host limits are classified; parsers throw a ParseFailureError.
checkCounted(
  "direct RangeError interpretation (use hostRangeErrorKind or parseFailureFromCause from src/domain/parseFailure)",
  "range-error-interpretation",
  files,
  /instanceof RangeError/gu,
  ["src/domain/parseFailure.ts"],
);

// Cleanup completion is recorded by the owning lease and read by errors when
// asked. Pushing it with resolveCleanup() and composing dependency sets with
// bindCleanupDependencies() are being replaced, so neither may spread.
checkCounted(
  "resolveCleanup() push outside the error base (release the owning AnalysisCleanupLease instead)",
  "cleanup-resolve-push",
  files,
  /\.resolveCleanup\(/gu,
  ["src/domain/analysisErrorBase.ts"],
);
checkCounted(
  "bindCleanupDependencies() composition outside the error base (compose through runOwned or copy lease claims)",
  "cleanup-dependency-binding",
  files,
  /\.bindCleanupDependencies\(/gu,
  ["src/domain/analysisErrorBase.ts"],
);

// `find` on a parsed section, program-header or load-command table silently
// keeps the first of repeated declarations. Select keyed entries through
// src/domain/keyedCollection (`uniqueKeyed`, `allKeyed`, or
// `firstKeyed`/`lastKeyed` with the format's precedence rule); an
// address-containment test that selects nothing uses `some`. GuidanceAccess
// looks up a guidance document's heading section by its locator identity,
// not a parsed binary section table.
checkCounted(
  "first-match section, program or command lookup (select through src/domain/keyedCollection)",
  "section-first-match",
  files,
  /\b(?:sections|programs|commands)\.find(?:Last)?\(/gu,
  ["src/application/GuidanceAccess.ts"],
);

// The same first-match choice, recognized by its shape rather than the
// table's variable name (see keyed-first-match.mjs). Select through
// src/domain/keyedCollection instead.
checkCounted(
  "first-match lookup by key field in a parser (select through src/domain/keyedCollection)",
  "keyed-first-match",
  parserFiles,
  countKeyedFirstMatches,
  [],
);

if (baselinesShrunk) {
  const sorted = Object.fromEntries(
    Object.entries(baselines).map(([key, counts]) => [
      key,
      Object.fromEntries(
        Object.entries(counts).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      ),
    ]),
  );
  await writeFile(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`Lowered counted baselines in ${relative(root, baselinePath)}.`);
}

if (failures.length > 0) {
  console.error(`Architecture guards failed:\n\n${failures.join("\n\n")}\n`);
  process.exit(1);
}
// CI runs this file before `npm ci`. The numeric-limit parser needs
// typescript6, so that check waits until dependencies exist. `npm run lint`
// runs it after install.
const typescript6 = new URL(
  "../../node_modules/typescript6/package.json",
  import.meta.url,
);
if (!existsSync(typescript6)) {
  console.log(
    "Numeric REA_ limit check waits until dependencies are installed.",
  );
} else {
  const numericLimits = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./rea-numeric-limits.mjs", import.meta.url))],
    { stdio: "inherit" },
  );
  if (numericLimits.status !== 0) process.exit(numericLimits.status ?? 1);
}
console.log(`Architecture guards passed across ${files.length} source files.`);
