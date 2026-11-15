import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { recordPredicateCounts } from "./record-predicate-guard.mjs";
import {
  compareCountedBaseline,
  recordLoweredBaseline,
  reconcileBaselineFile,
} from "./counted-baseline.mjs";
import { localCompletenessEnumCount } from "./completeness-enum-guard.mjs";
import { countKeyedFirstMatches } from "./keyed-first-match.mjs";
import { budgetArithmeticCount } from "./budget-arithmetic-guard.mjs";
import { localLimitErrorClassCount } from "./limit-class-guard.mjs";

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

// Completeness is a claim its producer establishes from examined input. A
// fallback or default of `true` turns an unstated claim into a complete one.
check(
  "completeness defaulted to true (leave it unknown or require the producer to state it)",
  files,
  /\b(?:complete|exhaustive|\w+Complete|\w+Exhaustive|\w+_complete|\w+_exhaustive)\w*\s*(?:\?\?\s*true\b|(?::\s*boolean\s*)?=\s*true\s*[,)])/u,
);

// Prerequisite inspection lifetime is an application contract shared by adapters.
check(
  "provider-owned inspection lifetime (use src/ports/ProviderInspectionScope)",
  files,
  /providers\/ProviderInspectionScope\.js/,
);

check("NUL-joined list key (use compositeKey)", files, /\.join\(["']\\0["']\)/);

// Pushed effect invalidation (docs/adr/javascript/pushed-effect-invalidation.md).
// Opaque-effect checks are private to javascriptSemanticEffectLog.ts, so the
// compiler keeps readers on its questions, and only the log and its record
// module read the recorded sites. A method read on an intrinsic
// instance asks one owner, which checks the method, the instance's prototype
// link and the intrinsic prototypes.
check(
  "reader-side read of recorded opaque effects (ask javascriptSemanticEffectLog.ts or the javascriptSemanticEffectRecord.ts accessors)",
  files,
  /\.opaqueEffects\b/u,
  [
    "src/domain/javascript/javascriptSemanticEffectLog.ts",
    "src/domain/javascript/javascriptSemanticEffectRecord.ts",
  ],
);

check(
  "reader-side prototype-link member check (use isIntrinsicInstanceMethodCall)",
  files,
  /mayObserve\([^;]*\["__proto__"\]/u,
  ["src/domain/javascript/javascriptSemanticIntrinsicInstances.ts"],
);

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
// raises them) so the next removal cannot be undone silently. Each guard's
// baseline is its own file, scripts/verify/baselines/<key>.json, so changes
// to different guards never edit the same file.
const baselineDirectory = join(root, "scripts/verify/baselines");
const baselineTexts = new Map();
for (const name of await readdir(baselineDirectory)) {
  if (!name.endsWith(".json")) {
    failures.push(
      `${relative(root, join(baselineDirectory, name))} is not a guard baseline; only <guard-key>.json files belong in ${relative(root, baselineDirectory)}.`,
    );
    continue;
  }
  baselineTexts.set(
    name.slice(0, -".json".length),
    await readFile(join(baselineDirectory, name), "utf8"),
  );
}
const baselines = Object.fromEntries(
  [...baselineTexts].map(([key, text]) => [key, JSON.parse(text)]),
);
const checkedBaselineKeys = new Set();
const shrinkBaselines = process.argv.includes("--shrink-baselines");
let baselinesShrunk = false;
const checkCounted = (label, key, selected, pattern, owners) => {
  checkedBaselineKeys.add(key);
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

// A provider failure's captured output comes from one owner,
// capturedProviderOutput in src/process; local copies drift on byte counts
// (retained or written) and on how output loss marks truncation.
checkCounted(
  "captured output copied from a process snapshot (use capturedProviderOutput from src/process/capturedProviderOutput)",
  "captured-output-copy",
  files,
  /\bstdout: [\w.]+\.stdout\.text\b/gu,
  ["src/process/capturedProviderOutput.ts"],
);

// Pushed effect invalidation (docs/adr/javascript/pushed-effect-invalidation.md).
// Recorded effects belong to the effect log. A reader that reads an effect
// index itself decides on its own which effect kinds and proofs apply; new
// readers ask the log instead, and each migrated reader lowers this count.
checkCounted(
  "read of a JavaScript effect index outside the effect log (ask javascriptSemanticEffectLog.ts)",
  "javascript-effect-index-read",
  files,
  /\.(?:bindingWrites|memberWrites|escapedPaths|ambientWriteEffects|ambientEscapeEffects|ambientBindingWrites|ambientWrites|ambientEscapes)\b/gu,
  ["src/domain/javascript/javascriptSemanticEffectLog.ts"],
);

// Coverage status has one vocabulary, coverageStatusSchema in
// src/domain/coverage.ts. A local enum that contains "complete" either copies
// it or drops `unknown`, which forces an unknown producer to pick a side.
checkCounted(
  "local completeness enum (use coverageStatusSchema from src/domain/coverage)",
  "local-completeness-enum",
  files,
  localCompletenessEnumCount,
  ["src/domain/coverage.ts"],
);

// Cancellation reasons are required by `cancelledBy` in analysisErrorCore; a
// direct construction can omit or replace the caller's reason.
checkCounted(
  "direct AnalysisCancelledError construction (use cancelledBy from src/domain/analysisErrorCore)",
  "analysis-cancelled-constructor",
  files,
  /new AnalysisCancelledError\(/gu,
  ["src/domain/analysisErrorCore.ts"],
);

// A limit a parser stopped at is a ParseFailureError<"limit"> (decodeLimit in
// src/domain/parseFailure); a refusal is an AnalysisRefusal. A local limit
// class on plain Error hides the limit's name and maximum from both; a limit
// subclass of BinaryResourceFailure keeps a second limit field beside the
// allowance its LimitRef already names. The environment-state extraction's private retention stop is control flow that
// its own entry point catches and turns into `null`; it is never reported.
checkCounted(
  "local limit class (use decodeLimit from src/domain/parseFailure, a named BinaryResourceFailure allowance, or an AnalysisRefusal)",
  "local-limit-error-class",
  files,
  localLimitErrorClassCount,
  ["src/domain/analysisView/EnvironmentStateExtraction.ts"],
);

// A resource allowance is charged and refunded through `Budget` in
// src/domain/budget, which refuses malformed or oversized charges without
// changing the remainder. Hand-written `remaining -=` / `retained +=`
// arithmetic repeats that admission and drifts (charge-then-check, no
// safe-integer check).
checkCounted(
  "hand-written budget arithmetic (use Budget from src/domain/budget)",
  "budget-arithmetic",
  files,
  budgetArithmeticCount,
  ["src/domain/budget.ts"],
);

// A slice to a named maximum drops items; boundedList in src/domain/boundedList
// keeps the count of what it dropped beside the retained items, so a consumer
// can say that more exist and how many.
checkCounted(
  "slice to a named maximum (use boundedList or BoundedListCollector from src/domain/boundedList so the omitted count travels with the items)",
  "constant-maximum-slice",
  files,
  /\.slice\(\s*0\s*,\s*[A-Z][A-Z0-9_]*\s*\)/gu,
  ["src/domain/boundedList.ts"],
);

// Display text cut with an appended ellipsis comes from ellipsisExcerpt in
// src/domain/excerpt, which never splits a surrogate pair and marks the result
// as excerpt text. A hand-written `${text.slice(0, n)}…` does neither.
checkCounted(
  "hand-written ellipsis excerpt (use ellipsisExcerpt from src/domain/excerpt)",
  "ad-hoc-ellipsis",
  files,
  /\.slice\(\s*0\s*,[^)]*\)\)?\}(?:…|\.\.\.)/gu,
  ["src/domain/excerpt.ts"],
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

// Strict UTF-8 decoding has one owner, src/domain/strictUtf8.ts, which makes
// each site state its byte-order-mark policy. A local fatal decoder silently
// strips a leading BOM unless it remembers ignoreBOM. The pattern matches the
// options in any order and an omitted label. The remaining copy runs inside a
// browser page through page.evaluate, which cannot import the owner.
checkCounted(
  "local strict UTF-8 TextDecoder (use strictUtf8Decoder, decodeStrictUtf8 or isStrictUtf8 from src/domain/strictUtf8)",
  "strict-utf8-decoder",
  files,
  /new TextDecoder\(\s*(?:(?:["'`]utf-?8["'`]|undefined)\s*,\s*)?\{[^}]*\bfatal:\s*true/giu,
  ["src/domain/strictUtf8.ts"],
);

// Turning a completed result into a cancellation after cleanup is the
// finalization precedence that runOwned owns (src/providers/runOwned.ts).
checkCounted(
  "completed result reclassified by a hand-read abort signal (finalize through runOwned in src/providers/runOwned)",
  "completed-abort-reclassification",
  files,
  /\.ok\s*&&\s*(?:isAborted\(|[\w.?]*signal\??\.aborted)/gu,
  ["src/providers/runOwned.ts"],
);

// An abort reason names who ended the work: a typed `CallerAbort` at the CLI,
// MCP and HTTP adapters, or an `OwnerCancellation` when REA closes an owner.
// A bare `.abort()` leaves an anonymous platform AbortError as the cause.
// Playwright's `route.abort(errorCode)` takes a network error code instead;
// its call sites pass that code explicitly so the scan stays receiver-independent.
checkCounted(
  "AbortController.abort() without a reason (pass a CallerAbort or OwnerCancellation from src/domain/analysisErrorCore)",
  "abort-without-reason",
  files,
  /\.abort\(\s*\)/gu,
  [],
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

// Services name the contract field they refuse or ask the caller to change;
// the CLI layer owns option spellings (each command's field binding renames
// issue paths to CLI keys). A `--flag` written outside src/cli copies that
// mapping and goes stale when the command renames the option.
checkCounted(
  "REA CLI option named outside the CLI layer (name the contract field; src/cli owns option spellings)",
  "cli-option-text-outside-cli",
  files.filter(
    ({ path }) =>
      !path.startsWith("src/cli/") && !/^src\/cli[^/]*\.ts$/u.test(path),
  ),
  /\(CLI:? [^)\n]*--[a-z]|--[a-z][a-z0-9-]* on the CLI|or (?:use|pass) --[a-z]|\bcli(?:Flag|Total|PerFile)?:\s*"--[a-z]|(?:message|userMessage):\s*["`]--[a-z]/gu,
  [],
);

// A runtime setting view throws the ConfigurationError of a malformed launch
// seed; readRuntimeSetting in src/config/runtimeAnalysisSettings.ts returns it
// as a Result. Catching it by hand mixes it into each site's own failures.
checkCounted(
  "hand-caught ConfigurationError (read runtime settings with readRuntimeSetting from src/config/runtimeAnalysisSettings)",
  "hand-caught-configuration-error",
  files,
  /\bcause instanceof ConfigurationError\b/gu,
  ["src/config/runtimeAnalysisSettings.ts"],
);

// Byte-format parsers read untrusted input. Bounds, truncation and failure
// kind belong to BinaryReader (src/domain/binaryContainer.ts) and
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
  "raw Buffer or DataView numeric read (use BinaryReader from src/domain/binaryContainer)",
  "raw-buffer-read",
  files,
  /\.(?:read(?:Big)?U?Int(?:8|16|32|64)?(?:LE|BE)?|readBigUint64(?:LE|BE)|readUint(?:8|16|32)(?:LE|BE)?|read(?:Float|Double)(?:LE|BE)|get(?:Big)?(?:Uint|Int)(?:8|16|32|64)|getFloat(?:32|64))\(/gu,
  ["src/domain/binaryContainer.ts"],
);

// An input fault is a ParseFailureError; a broken internal assumption is a
// defect, not an input fault, and throws invariantViolation from
// src/domain/internalInvariant so callers never read it as bad bytes.
// Process-lifecycle owners in parser folders read their private helper's
// replies through schemas; their plain throws report the helper's startup,
// handshake and cleanup outcomes, which are process failures, not parse faults.
const PROCESS_LIFECYCLE_OWNERS = [
  "src/android/JadxWorkspaceRoot.ts",
  "src/native/pwntools/PwntoolsDecoder.ts",
];
const PLAIN_THROW = /throw new (?:Error|TypeError|RangeError)\(/gu;
checkCounted(
  "plain Error, TypeError or RangeError thrown by a parser (throw a ParseFailureError from src/domain/parseFailure for an input fault, or invariantViolation from src/domain/internalInvariant for a broken internal assumption)",
  "parser-plain-throw",
  parserFiles.filter((file) => !PROCESS_LIFECYCLE_OWNERS.includes(file.path)),
  PLAIN_THROW,
  [],
);
// The lifecycle owners' existing process-failure throws are counted, so a
// parse fault or defect added there later cannot hide behind the exemption.
checkCounted(
  "plain Error, TypeError or RangeError thrown by a parser-folder process-lifecycle owner (keep its existing process-failure throws; throw a ParseFailureError for an input fault or invariantViolation for a broken internal assumption)",
  "lifecycle-plain-throw",
  parserFiles.filter((file) => PROCESS_LIFECYCLE_OWNERS.includes(file.path)),
  PLAIN_THROW,
  [],
);

// A per-format failure class restates the ParseFailure algebra under its own
// spelling and needs its own catch-site translation; parsers throw a
// ParseFailureError instead. A subclass of ParseFailureError (such as
// CaptureFormatError) keeps the shared kind and is not counted. The name
// pattern covers format, parse, document, source, decode and syntax failures,
// and any property-list or archive failure (such as a nesting limit or an
// unsupported UID), built on any of the host's general error classes.
checkCounted(
  "per-format failure class extending a host error (throw a ParseFailureError from src/domain/parseFailure)",
  "parser-format-failure-class",
  files,
  /class (?:\w*(?:Format|Parse|Document|Source|Decode|Decoding|Encoding|Syntax)|\w*(?:Plist|PropertyList|Archive)\w*)(?:Failure|Error|Issue) extends (?:Error|TypeError|RangeError|SyntaxError)\b/gu,
  ["src/domain/parseFailure.ts"],
);

// Mach-O load-command codes have one table; a literal code in a load-command
// reader restates it and drifts from the named command it means.
checkCounted(
  "literal Mach-O load-command code (use LC from src/domain/apple/machoLoadCommandCodes)",
  "macho-load-command-literal",
  files.filter((file) =>
    /MachoLoadCommandCursor|readMachoLoadCommand|machoLoadCommandCodes/u.test(
      file.content,
    ),
  ),
  // An equality test, or membership in a literal list of codes.
  /\b(?:frame\.command|command\.kind|command|cmd)\s*[!=]==\s*(?:0x[0-9a-fA-F]+|\d+)\b|\[\s*(?:0x[0-9a-fA-F]+|\d+)(?:\s*,\s*(?:0x[0-9a-fA-F]+|\d+))*\s*,?\s*\]\s*\.(?:includes|indexOf)\(\s*(?:\w+\.)*(?:command|cmd|kind)\s*\)/gu,
  ["src/domain/apple/machoLoadCommandCodes.ts"],
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

// Raw JSON Schema keywords and `x-rea-*` markers in `.meta()` bypass the
// canonical Zod checks and reach every JSON Schema projection, including the
// advertised one. Presentation facts are typed annotations
// (src/domain/schemaAnnotations); constraints belong in Zod checks, or in a
// src/domain/schemaConstraints helper that adds the check and its keyword
// together.
checkCounted(
  "raw JSON Schema keyword or x-rea marker in Zod .meta() (use a typed annotation from src/domain/schemaAnnotations, a Zod check, or a src/domain/schemaConstraints helper)",
  "raw-json-schema-meta",
  files,
  /\.meta\(\s*\{\s*"?(?:x-rea-[\w-]+|\$ref|not|allOf|anyOf|oneOf|if|then|else|dependentRequired|dependentSchemas|dependencies|uniqueItems|(?:min|max)(?:Length|Items|Properties|imum)|exclusive(?:Min|Max)imum|multipleOf|type|const|enum|format|pattern|patternProperties|properties|required|additionalProperties|items|prefixItems|contains|content(?:MediaType|Encoding|Schema)|propertyNames)"?\s*:/gu,
  ["src/domain/schemaConstraints.ts"],
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

// Cleanup completion is recorded by the owner and read by errors when asked;
// AnalysisError has no push API. Composing dependency sets with
// bindCleanupDependencies() is being replaced, so it may not spread.
checkCounted(
  "bindCleanupDependencies() composition outside the error base (compose through analysisErrorWithCleanupDependencies or runOwned, or copy lease claims)",
  "cleanup-dependency-binding",
  files,
  /\.bindCleanupDependencies\(/gu,
  ["src/domain/analysisErrorBase.ts", "src/domain/analysisErrorCleanup.ts"],
);

// A launcher's PATH search order (POSIX empty and relative entries and `..`;
// Windows quoted entries and PATHEXT) belongs to src/process/executableSearch;
// callers choose only how they probe each candidate.
checkCounted(
  "PATH or PATHEXT split outside the executable search owner (use posixPathCandidates or windowsPathCandidates from src/process/executableSearch)",
  "path-search-split",
  files,
  /\.split\(\s*(?:posix\.|win32\.)?(?:delimiter|pathDelimiter)\s*\)|\bPATH\b[^\n]{0,12}\.split\(":"\)|\bPATHEXT\b[^\n]{0,60}\.split\(/gu,
  ["src/process/executableSearch.ts"],
);

// The running host is read once by src/platform/HostPlatform; composition
// takes it from there and passes the platform or architecture on as a
// required parameter. An ambient read elsewhere mixes the host REA runs on
// with the host a caller asked about, and cannot be selected by a test.
// Named imports from node:process or node:os and os.platform()/os.arch() are
// the same read under another spelling.
const ambientHostRead = (property, osFunction) =>
  new RegExp(
    String.raw`\bprocess\.${property}\b|\bos\.${osFunction}\(\)|\bimport\s*(?:type\s*)?\{[^}]*\b(?:${property}|${osFunction})\b[^}]*\}\s*from\s*["'](?:node:)?(?:process|os)["']`,
    "gu",
  );
checkCounted(
  "ambient process.platform read (take HOST_PLATFORM from src/platform/HostPlatform at composition and pass the platform as a parameter)",
  "ambient-host-platform",
  files,
  ambientHostRead("platform", "platform"),
  ["src/platform/HostPlatform.ts"],
);
checkCounted(
  "ambient process.arch read (take HOST_PLATFORM from src/platform/HostPlatform at composition and pass the architecture as a parameter)",
  "ambient-host-architecture",
  files,
  ambientHostRead("arch", "arch"),
  ["src/platform/HostPlatform.ts"],
);

// Tests select a platform or architecture by injecting it (a parameter, a
// `host` option, or a mock of src/platform/HostPlatform). Redefining
// process.platform or process.arch stops exercising its branch once the module
// under test takes the host from HostPlatform, and still passes. Each module
// migration switches its tests to injection and lowers this baseline.
const listTestFiles = async (dir) => {
  const output = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...(await listTestFiles(path)));
    else if (/\.(?:test|spec|fixture)\.ts$/u.test(entry.name))
      output.push(path);
  }
  return output;
};
const testFiles = await Promise.all(
  [
    ...(await listTestFiles(join(root, "src"))),
    ...(await listFiles(join(root, "tests"))),
    ...(await listTestFiles(join(root, "tests"))),
  ].map(async (path) => ({
    path: relative(root, path).split(sep).join("/"),
    content: await readFile(path, "utf8"),
  })),
);
checkCounted(
  "test redefines process.platform or process.arch (inject the platform: pass it as a parameter or host option, or mock src/platform/HostPlatform)",
  "test-host-platform-stub",
  testFiles,
  /\b(?:defineProperty|spyOn)\(\s*(?:globalThis\.)?process\s*,\s*["'`](?:platform|arch)["'`]/gu,
  [],
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

// A verifier fixture root is removed only after the MCP clients, sessions and
// processes that may still use it confirm cleanup; otherwise it is retained
// and named. scripts/lib/verifier-fixture.mjs owns that ordering on a
// src/process PrivateRuntimeRoot, so verifiers allocate roots through it.
const verifierScripts = await Promise.all(
  (await readdir(join(root, "scripts"), { recursive: true }))
    .map((path) => path.split(sep).join("/"))
    .filter(
      (path) =>
        /^(?:verify-[^/]+|verify\/.+)\.mjs$/u.test(path) &&
        path !== "verify/architecture-guards.mjs",
    )
    .map(async (path) => ({
      path: `scripts/${path}`,
      content: stripComments(
        await readFile(join(root, "scripts", path), "utf8"),
      ),
    })),
);
// The Windows native lane tests PrivateRuntimeRoot itself: it calls
// PrivateRuntimeRoot.create under a parent whose DELETE lease forces a sharing
// violation and asserts the typed refusal. That call is the subject under
// test, not a verifier root, so exactly one occurrence of that expression is
// exempt; any other allocation in the file, including a second copy of it,
// still counts.
const verifierRootSubjectsUnderTest = new Map([
  [
    "scripts/verify-windows-native.mjs",
    "PrivateRuntimeRoot.create({ parent: sharingParent.observation.path })",
  ],
]);
checkCounted(
  "verifier fixture root allocated outside VerifierFixture (use scripts/lib/verifier-fixture.mjs)",
  "verifier-fixture-root",
  verifierScripts.map((file) => {
    const subject = verifierRootSubjectsUnderTest.get(file.path);
    return subject === undefined
      ? file
      : { ...file, content: file.content.replace(subject, "") };
  }),
  /\b(?:mkdtemp(?:Sync)?|createCanonicalTemporaryDirectory)\(|\bPrivateRuntimeRoot\.create\(/gu,
  [],
);

for (const key of baselineTexts.keys())
  if (!checkedBaselineKeys.has(key))
    failures.push(
      `${relative(root, join(baselineDirectory, `${key}.json`))} names no counted guard; delete it or restore its guard.`,
    );
for (const key of checkedBaselineKeys) {
  const path = join(baselineDirectory, `${key}.json`);
  const shown = relative(root, path);
  const baselineFile = reconcileBaselineFile(
    baselineTexts.get(key),
    baselines[key],
    shrinkBaselines,
  );
  if (baselineFile.action === "write") {
    await writeFile(path, baselineFile.text);
    console.log(`Rewrote ${shown}.`);
  } else if (baselineFile.action === "delete") {
    await rm(path);
    console.log(`Removed ${shown}; its guard has no remaining copies.`);
  } else if (baselineFile.action === "reject")
    failures.push(
      `${shown} is not in its written form (paths sorted by code unit); rewrite it with \`node scripts/verify/architecture-guards.mjs --shrink-baselines\`.`,
    );
}
if (baselinesShrunk) console.log("Lowered counted baselines.");

if (failures.length > 0) {
  console.error(`Architecture guards failed:\n\n${failures.join("\n\n")}\n`);
  process.exit(1);
}
console.log(`Architecture guards passed across ${files.length} source files.`);
