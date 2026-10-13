import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: Object.fromEntries(
    ["artifact", "artifact-json", "evidence", "keccak-module", "output"].map(
      (key) => [key, { type: "string" }],
    ),
  ),
});
assert.ok(values.artifact, "Select the exact corpus artifact ID");
for (const key of ["artifact-json", "evidence", "keccak-module", "output"])
  assert.ok(isAbsolute(values[key] ?? ""), `${key} requires an absolute path`);
const corpus = JSON.parse(
  await readFile(new URL("./corpus.json", import.meta.url), "utf8"),
);
const selected = corpus.artifacts.find(({ id }) => id === values.artifact);
assert.ok(selected?.provenance.compiler_artifact_sha256);
const source = await readFile(values["artifact-json"]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(hash(source), selected.provenance.compiler_artifact_sha256);
assert.equal(source.length, selected.provenance.compiler_artifact_bytes);
const artifact = JSON.parse(source);
const carrier = Buffer.from(artifact.deployedBytecode + "\n");
assert.equal(hash(carrier), selected.sha256);
assert.equal(carrier.length, selected.bytes);
const { keccak_256 } = (await import(pathToFileURL(values["keccak-module"])))
  .default;
assert.equal(
  typeof keccak_256,
  "function",
  "Supply js-sha3's Ethereum Keccak implementation",
);
const canonicalType = (input) =>
  input.type.startsWith("tuple")
    ? `(${input.components.map(canonicalType).join(",")})${input.type.slice(5)}`
    : input.type;
const selectors = artifact.abi
  .filter((entry) => entry.type === "function")
  .map((entry) => {
    const signature = `${entry.name}(${entry.inputs.map(canonicalType).join(",")})`;
    return { signature, selector: `0x${keccak_256(signature).slice(0, 8)}` };
  });
const reply = JSON.parse(await readFile(values.evidence, "utf8"));
const evidence = reply.structuredContent ?? reply;
assert.equal(evidence.operation, "inspect_evm_interface");
assert.equal(evidence.subject.digest.sha256, selected.sha256);
assert.equal(evidence.normalized_result.artifact.sha256, selected.sha256);
assert.equal(
  evidence.normalized_result.bytecode.sha256,
  selected.decoded_sha256,
);
assert.equal(
  hash(Buffer.from(evidence.normalized_result.bytecode.hex, "hex")),
  selected.decoded_sha256,
);
assert.equal(evidence.normalized_result.bytecode.bytes, selected.decoded_bytes);
assert.equal(evidence.normalized_result.evidence_kind, "inferred");
assert.equal(evidence.normalized_result.discovery_completeness, "unknown");
const observed = evidence.normalized_result.functions
  .filter((entry) => entry.dispatch === "abi")
  .map((entry) => entry.selector);
assert.deepEqual(
  observed.toSorted(),
  selectors.map((entry) => entry.selector).toSorted(),
);
await writeFile(
  values.output,
  JSON.stringify(
    {
      artifact: selected.id,
      compiler_artifact_sha256: hash(source),
      keccak_module_sha256: hash(await readFile(values["keccak-module"])),
      evidence_id: evidence.evidence_id,
      selector_set_matches_published_abi: true,
      selectors,
      scope:
        "Independent published ABI-derived selector oracle; no deployed authenticity, inferred argument/mutability equivalence or runtime verification is established.",
    },
    null,
    2,
  ) + "\n",
  { flag: "wx", mode: 0o600 },
);
process.stdout.write(
  JSON.stringify({
    artifact: selected.id,
    selector_count: selectors.length,
    selector_set_matches_published_abi: true,
  }) + "\n",
);
