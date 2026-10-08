import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, onTestFinished } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseEvidence } from "../../../src/domain/evidence.js";
const entrypoint = fileURLToPath(
  new URL("../../../scripts/rea.mjs", import.meta.url),
);
const cli = async (
  path: string,
  format: string,
  extra: readonly string[] = [],
) => {
  try {
    const result = await promisify(execFile)(
      process.execPath,
      [
        entrypoint,
        "inspect-web-network-capture",
        path,
        format,
        "--json",
        ...extra,
      ],
      { env: { ...process.env, REA_MITMDUMP_COMMAND: "" }, timeout: 40_000 },
    );
    return { ok: true, stdout: result.stdout };
  } catch (cause: unknown) {
    if (
      cause instanceof Error &&
      "stdout" in cause &&
      typeof cause.stdout === "string"
    )
      return { ok: false, stdout: cause.stdout };
    throw cause;
  }
};
import { historicalHar } from "../../fixtures/historicalHar.js";

it("reads actual upstream HAR packages in an owned process and retains selected producer order", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-history-har-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const fixture = historicalHar();
  const first = fixture.log.entries[0];
  if (first === undefined) throw new Error("fixture missing");
  fixture.log.entries.push(structuredClone(first));
  const text = JSON.stringify(fixture);
  const path = join(root, "capture.har");
  await writeFile(path, text);
  const called = await cli(path, "har", ["--record", "1", "--record", "0"]);
  expect(called.ok, called.stdout).toBe(true);
  const result = { value: parseEvidence(JSON.parse(called.stdout)) };
  expect(result.value.subject?.digest).toMatchObject({
    sha256: createHash("sha256").update(text).digest("hex"),
  });
  expect(result.value.normalized_result).toMatchObject({
    total_records: 2,
    records: [{ ordinal: 1 }, { ordinal: 0 }],
    runtime_attribution: "unknown",
  });
});

it("keeps malformed JSON separate from absent external mitmproxy capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-history-errors-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "capture.har");
  await writeFile(path, "{malformed-private-json");
  const malformed = await cli(path, "har");
  expect(malformed.ok).toBe(false);
  expect(JSON.parse(malformed.stdout)).toMatchObject({
    category: "invalid_input",
  });
  expect(malformed.stdout).not.toContain("malformed-private-json");
  const missing = await cli(path, "mitmproxy");
  expect(missing.ok).toBe(false);
  expect(JSON.parse(missing.stdout)).toMatchObject({
    category: "unsupported_provider",
  });
});

it("reports the actual HAR decoder nesting constraint as a typed selected-input issue", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-history-depth-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  let extension: unknown = "leaf";
  for (let depth = 0; depth < 66; depth++) extension = { child: extension };
  const path = join(root, "deep.har");
  await writeFile(
    path,
    JSON.stringify({ ...historicalHar(), _extension: extension }),
  );
  const result = await cli(path, "har");
  expect(result.ok).toBe(false);
  expect(JSON.parse(result.stdout)).toMatchObject({
    category: "invalid_input",
    details: {
      issues: [
        {
          path: ["capture_path", expect.stringMatching(/^\/_extension\/child/)],
          reason: "out_of_range",
          expected: { maximum_capture_nesting: 64 },
        },
      ],
    },
  });
});
