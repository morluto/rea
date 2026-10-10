import assert from "node:assert/strict";
import { constants } from "node:buffer";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";

import { Cli } from "incur";

import { createStreamedCliJsonOutput } from "../../../dist/cli/streamedJsonOutput.js";
import { createEvidence } from "../../../dist/domain/evidence.js";

// This opt-in format-boundary check writes one temporary file larger than the
// actual engine string limit. Shared leaves keep the analysis input small.
const format = process.argv[2] ?? "json";
assert.ok(format === "json" || format === "jsonl", "Use json or jsonl");
const leaf = "x".repeat(64 * 1024);
const encodedLeaf = JSON.stringify(leaf);
const count = Math.ceil(constants.MAX_STRING_LENGTH / (leaf.length + 3)) + 1;
const volume = await statfs(tmpdir());
assert.ok(
  volume.bavail * volume.bsize > count * encodedLeaf.length + 1024 ** 3,
  "Large-output verification needs room for one output file and a 1-GiB reserve",
);
const workspace = await mkdtemp(join(tmpdir(), "rea-javascript-output-"));
const path = join(workspace, "result.json");
let destination;
let peakRss = process.memoryUsage().rss;
const sampleRss = () => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
};
const sampler = setInterval(sampleRss, 25);
sampler.unref();
let finalReport;

try {
  const evidence = createEvidence(
    undefined,
    { id: "large-output-fixture", name: "Large output fixture", version: "1" },
    {
      operation: "inspect_fixture",
      parameters: {},
      result: { payload: Array.from({ length: count }, () => leaf) },
    },
  );
  sampleRss();
  const metadata = { command: "inspect-output-fixture", duration: "0ms" };
  const marker = "__REA_OUTPUT_ENCODING_MARKER__";
  const template = {
    ok: true,
    data: { ...evidence, normalized_result: { payload: [marker] } },
    meta: metadata,
  };
  // The destination is a redirected file, so both formats are compact.
  const skeleton = JSON.stringify(template);
  const encodedMarker = JSON.stringify(marker);
  const markerIndex = skeleton.indexOf(encodedMarker);
  assert.ok(markerIndex >= 0);
  assert.equal(markerIndex, skeleton.lastIndexOf(encodedMarker));
  const prefix = skeleton.slice(0, markerIndex);
  const suffix = `${skeleton.slice(markerIndex + encodedMarker.length)}\n`;
  const separator = ",";
  const expectedHash = createHash("sha256");
  expectedHash.update(prefix);
  for (let index = 0; index < count; index += 1) {
    if (index > 0) expectedHash.update(separator);
    expectedHash.update(encodedLeaf);
  }
  expectedHash.update(suffix);
  const expectedBytes =
    Buffer.byteLength(prefix) +
    count * Buffer.byteLength(encodedLeaf) +
    (count - 1) * Buffer.byteLength(separator) +
    Buffer.byteLength(suffix);
  assert.ok(expectedBytes > constants.MAX_STRING_LENGTH);

  destination = createWriteStream(path, { flags: "wx", mode: 0o600 });
  const argv = [metadata.command, "--format", format, "--full-output"];
  const output = createStreamedCliJsonOutput(argv, destination);
  assert.ok(output);
  let unexpectedOutputBytes = 0;
  let exitCode = 0;
  await Cli.create("rea-output-verifier", { sync: false })
    .command(metadata.command, {
      run: async ({ format: selectedFormat }) => {
        assert.equal(
          await output.write(evidence, { ...metadata, format: selectedFormat }),
          true,
        );
      },
    })
    .serve(argv, {
      stdout: (text) => {
        if (!output.handled) unexpectedOutputBytes += Buffer.byteLength(text);
      },
      exit: (code) => {
        exitCode = code;
      },
    });
  destination.end();
  await finished(destination);
  assert.equal(exitCode, 0);
  assert.equal(output.handled, true);
  assert.equal(output.failed, false);
  assert.equal(unexpectedOutputBytes, 0);

  const actualHash = createHash("sha256");
  for await (const chunk of createReadStream(path)) actualHash.update(chunk);
  const digest = actualHash.digest("hex");
  assert.equal(digest, expectedHash.digest("hex"));
  assert.equal((await stat(path)).size, expectedBytes);
  sampleRss();
  finalReport = {
    json_output_verified: true,
    format,
    output_bytes: expectedBytes,
    engine_string_limit: constants.MAX_STRING_LENGTH,
    output_sha256: digest,
    evidence_id: evidence.evidence_id,
    rss: { method: "node-memoryUsage-rss-sampled", peak_bytes: peakRss },
  };
} finally {
  clearInterval(sampler);
  if (destination !== undefined && !destination.closed) {
    const closed = once(destination, "close");
    destination.destroy();
    await closed;
  }
  await rm(workspace, { recursive: true, force: true });
}
process.stdout.write(`${JSON.stringify(finalReport)}\n`);
