import { fileURLToPath, pathToFileURL } from "node:url";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { processTest } from "../../support/process/processFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const bootstrapFixture = async () => {
  const root = await createTestTempDirectory("rea-android-bootstrap-");
  for (const path of [
    "scripts/fixtures/android/fetch.mjs",
    "scripts/fixtures/android/apidemos.json",
    "src/android/JadxRelease.ts",
  ]) {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(
      fileURLToPath(new URL(`../../../${path}`, import.meta.url)),
      destination,
    );
  }
  return root;
};

processTest(
  "loads the Android fixture fetcher before build or dependency installation",
  async ({ processes }) => {
    const root = await bootstrapFixture();
    // Copy the actual bootstrap inputs into a checkout without dist or
    // node_modules so an installed dependency cannot hide a new coupling.
    const entry = join(root, "scripts/fixtures/android/fetch.mjs");
    // Invalid arguments stop before downloads while exercising Node's real
    // source-module loading, without Vitest's .js-to-.ts resolution.
    const result = await processes.run(
      process.execPath,
      [entry, "extra", "argument"],
      { timeoutMs: 10000 },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Usage: npm run fixtures:android -- [DIRECTORY]",
    );
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  },
);

for (const { name, statuses, body, exitCode, requests, error } of [
  {
    name: "recovers from a gateway timeout",
    statuses: [504, 200, 200],
    body: "fixture",
    exitCode: 0,
    requests: 3,
    error: "",
  },
  {
    name: "stops after three transient failures",
    statuses: [504, 504, 504],
    body: "fixture",
    exitCode: 1,
    requests: 3,
    error: "HTTP 504",
  },
  {
    name: "does not retry permanent HTTP failures",
    statuses: [403],
    body: "fixture",
    exitCode: 1,
    requests: 1,
    error: "HTTP 403",
  },
  {
    name: "does not retry checksum failures",
    statuses: [200],
    body: "changed",
    exitCode: 1,
    requests: 1,
    error: "SHA-256 mismatch",
  },
])
  processTest(`Android fixture download ${name}`, async ({ processes }) => {
    const root = await bootstrapFixture();
    const sha256 = createHash("sha256").update("fixture").digest("hex");
    await writeFile(
      join(root, "src/android/JadxRelease.ts"),
      `export const JADX_RELEASE = ${JSON.stringify({ url: "https://fixture.invalid/engine", sha256 })};`,
    );
    await writeFile(
      join(root, "scripts/fixtures/android/apidemos.json"),
      JSON.stringify({
        url: "https://fixture.invalid/apk",
        sha256,
        filename: "fixture.apk",
      }),
    );
    const preload = join(root, "fetch-fixture.mjs");
    const calls = join(root, "requests.json");
    await writeFile(
      preload,
      `
import { writeFileSync } from "node:fs";
const statuses = ${JSON.stringify(statuses)};
const requests = [];
globalThis.fetch = async (url, options) => {
  if (options.headers.Accept !== "application/octet-stream") throw new Error("Release assets require binary content negotiation");
  requests.push(url);
  writeFileSync(${JSON.stringify(calls)}, JSON.stringify(requests));
  const status = statuses.shift();
  if (status === undefined) throw new Error("Unexpected download attempt");
  return new Response(${JSON.stringify(body)}, { status });
};
`,
    );
    const directory = join(root, "downloads");
    const result = await processes.run(
      process.execPath,
      [
        "--import",
        pathToFileURL(preload).href,
        join(root, "scripts/fixtures/android/fetch.mjs"),
        directory,
      ],
      { timeoutMs: 15000 },
    );
    expect(result.exitCode, result.stderr).toBe(exitCode);
    expect(JSON.parse(await readFile(calls, "utf8"))).toHaveLength(requests);
    if (exitCode === 0) {
      expect(
        await readFile(
          join(directory, "jadx-headless-mcp-0.7.1-all.jar"),
          "utf8",
        ),
      ).toBe("fixture");
      expect(await readFile(join(directory, "fixture.apk"), "utf8")).toBe(
        "fixture",
      );
      expect(await readdir(directory)).toHaveLength(2);
    } else {
      expect(result.stderr).toContain(error);
      expect(await readdir(directory)).toEqual([]);
    }
  });
