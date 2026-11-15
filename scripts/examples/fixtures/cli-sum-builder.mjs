// A deterministic example implementer. REA itself does not generate this code.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

const [destination, revision, briefPath, extra] = process.argv.slice(2);
if (
  !destination ||
  !isAbsolute(destination) ||
  !["initial", "corrected"].includes(revision) ||
  !briefPath ||
  !isAbsolute(briefPath) ||
  extra !== undefined
)
  throw new Error(
    "Usage: cli-sum-builder.mjs ABSOLUTE_NEW_FILE initial|corrected ABSOLUTE_BRIEF_JSON",
  );

// Consume observed facts, not original source. The additive implementation is
// an explicit example inference from this small brief, not a general synthesis.
const briefBytes = await readFile(briefPath);
const brief = JSON.parse(briefBytes.toString("utf8"));
assert.equal(
  brief.facts?.length,
  2,
  "The example builder requires two declared cases",
);
const valid = brief.facts.find(({ id }) => id === "valid");
const invalid = brief.facts.find(({ id }) => id === "invalid");
assert.deepEqual(valid?.arguments, ["sum", "2", "5"]);
assert.deepEqual(invalid?.arguments, ["sum", "2", "nope"]);
assert.match(valid.observed_pty_output, /^-?\d+\r?\n$/u);
assert.match(invalid.observed_pty_output, /^[^\r\n]+\r?\n$/u);
const observed = Number(valid.observed_pty_output.trim());
const derivedOffset =
  observed -
  valid.arguments
    .slice(1)
    .map(Number)
    .reduce((a, b) => a + b, 0);
assert(Number.isSafeInteger(observed) && Number.isSafeInteger(derivedOffset));
for (const fact of [valid, invalid]) {
  assert(
    Number.isInteger(fact.observed_exit.code) &&
      fact.observed_exit.code >= 0 &&
      fact.observed_exit.code <= 255,
  );
  assert.equal(fact.observed_exit.reason, "exited");
}
const implementedOffset = derivedOffset + (revision === "initial" ? 1 : 0);
const invalidOutput = invalid.observed_pty_output.replace(/\r?\n$/u, "\n");

// Independent implementation: never imports, invokes, or reads the original.
await writeFile(
  destination,
  `const input = process.argv.slice(2);
let answer = ${implementedOffset};
let valid = input.length === 3 && input[0] === "sum";
for (let index = 1; index < input.length; index += 1) {
  if (!/^-?\\d+$/u.test(input[index])) valid = false;
  answer += Number(input[index]);
}
process.stdout.write(valid ? String(answer) + "\\n" : ${JSON.stringify(invalidOutput)});
process.exitCode = valid ? ${valid.observed_exit.code} : ${invalid.observed_exit.code};
`,
  { flag: "wx" },
);
process.stdout.write(
  JSON.stringify({
    revision,
    brief_path: briefPath,
    brief_sha256: createHash("sha256").update(briefBytes).digest("hex"),
    source_evidence_ids: brief.facts.flatMap(({ evidence_id }) =>
      evidence_id ? [evidence_id] : [],
    ),
    inferred_algorithm:
      "Sum two integer operands plus the offset derived from the observed valid case",
    derived_offset: derivedOffset,
    implemented_offset: implementedOffset,
    valid_exit_code: valid.observed_exit.code,
    invalid_exit_code: invalid.observed_exit.code,
  }) + "\n",
);
