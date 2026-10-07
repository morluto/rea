import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseEvidence } from "../../../dist/domain/evidence.js";
import { hashAndroidFile } from "../../../dist/android/AndroidTargetSnapshot.js";
import { JADX_RELEASE } from "../../../dist/android/JadxRelease.js";
import fixture from "../../fixtures/android/apidemos.json" with { type: "json" };
import { verifyAndroidCliCancellation } from "./cli-cancellation.mjs";
import { verifyAndroidMetadata } from "./metadata.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const apk = process.env.REA_ANDROID_TEST_APK;
const jar = process.env.REA_JADX_MCP_JAR;
if (apk === undefined || jar === undefined)
  throw new Error(
    "verify:android requires REA_ANDROID_TEST_APK and REA_JADX_MCP_JAR. Run npm run fixtures:android and select the downloaded files; see docs/android-analysis.md.",
  );
await access(apk);
await access(jar);
assert.equal(
  await hashAndroidFile(apk),
  fixture.sha256,
  "Real Android lane requires the fixed ApiDemos release fixture",
);
assert.equal(
  await hashAndroidFile(jar),
  JADX_RELEASE.sha256,
  "Real Android lane requires the audited headless JADX release JAR",
);
const java =
  process.env.JAVA_HOME === undefined
    ? "java"
    : resolve(process.env.JAVA_HOME, "bin/java");
const execute = promisify(execFile);
await execute(java, ["-version"], { timeout: 10_000 });
const entrypoint =
  process.env.REA_ANDROID_ENTRYPOINT ?? resolve(repository, "scripts/rea.mjs");
const environment = { ...process.env, REA_JADX_MCP_JAR: resolve(jar) };
const path = resolve(apk);
await verifyAndroidMetadata({
  java,
  jar: resolve(jar),
  apk: path,
  repository,
  execute,
  bridge: resolve(dirname(entrypoint), "../bridge/android/ReaJadxBridge.java"),
});
const tasks = [
  {
    name: "inspect_android_package",
    args: ["inspect-android-package", path],
    input: { path },
  },
  {
    name: "search_android_classes",
    args: ["search-android-classes", path, "ApiDemos"],
    input: { path, query: "ApiDemos" },
  },
  {
    name: "inspect_android_class",
    args: ["inspect-android-class", path, fixture.class_name],
    input: { path, class_name: fixture.class_name },
  },
  {
    name: "inspect_android_method",
    args: [
      "inspect-android-method",
      path,
      fixture.class_name,
      fixture.method_name,
    ],
    input: {
      path,
      class_name: fixture.class_name,
      method_name: fixture.method_name,
    },
  },
  {
    name: "trace_android_references",
    args: [
      "trace-android-references",
      path,
      fixture.class_name,
      "--method-name",
      "activityIntent",
    ],
    input: {
      path,
      class_name: fixture.class_name,
      method_name: "activityIntent",
    },
  },
];
const cliResults = new Map();
for (const task of tasks) {
  const response = await execute(
    process.execPath,
    [entrypoint, ...task.args, "--format", "json"],
    {
      cwd: repository,
      env: environment,
      timeout: 150_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const evidence = parseEvidence(JSON.parse(response.stdout));
  assert.equal(evidence.subject?.digest.sha256, fixture.sha256);
  assert.equal(evidence.operation, task.name);
  cliResults.set(task.name, evidence);
  console.log(`PASS CLI ${task.name}`);
}
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  cwd: repository,
  env: environment,
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});
const client = new Client({ name: "rea-real-android-verifier", version: "1" });
try {
  await client.connect(transport, { timeout: 30_000 });
  for (const task of tasks) {
    const response = await client.callTool(
      { name: task.name, arguments: task.input },
      { timeout: 150_000 },
    );
    assert.notEqual(response.isError, true, JSON.stringify(response));
    const structured = response.structuredContent;
    assert.ok(structured !== undefined && structured.evidence !== undefined);
    const evidence = parseEvidence(structured.evidence);
    assert.deepEqual(
      evidence.normalized_result,
      cliResults.get(task.name).normalized_result,
    );
    // Raw observations retain different workspace paths and load durations.
    // Validate each evidence ID independently; compare portable results/intent.
    assert.equal(structured.evidence_id, evidence.evidence_id);
    assert.deepEqual(evidence.parameters, cliResults.get(task.name).parameters);
    assert.deepEqual(evidence.provider, cliResults.get(task.name).provider);
    assert.deepEqual(
      evidence.subject.digest,
      cliResults.get(task.name).subject.digest,
    );
    assert.deepEqual(
      evidence.limitations,
      cliResults.get(task.name).limitations,
    );
    assert.equal(evidence.confidence, cliResults.get(task.name).confidence);
    assert.deepEqual(structured.result, evidence.normalized_result);
    console.log(`PASS MCP/CLI parity ${task.name}`);
  }
} catch (cause) {
  process.stderr.write(stderr);
  throw cause;
} finally {
  await client.close();
}
const packageResult = cliResults.get(
  "inspect_android_package",
).normalized_result;
assert.equal(packageResult.package_name, fixture.package);
assert.equal(packageResult.version_name, fixture.version);
assert.equal(packageResult.min_sdk, "26");
assert.equal(packageResult.target_sdk, "33");
assert.equal(packageResult.manifest.status, "complete");
assert.ok(packageResult.manifest.text.includes(fixture.package));
assert.ok(packageResult.permissions.includes("android.permission.INTERNET"));
assert.equal(packageResult.signature_verification, "not_performed");
assert.ok(
  cliResults
    .get("search_android_classes")
    .normalized_result.matches.includes(fixture.class_name),
);
const classResult = cliResults.get("inspect_android_class").normalized_result;
assert.ok(
  classResult.methods.some((method) => method.name === fixture.method_name),
);
const method = cliResults.get("inspect_android_method").normalized_result;
assert.equal(method.representation, "java");
assert.equal(method.body_status, "available");
assert.equal(method.source.status, "complete");
assert.ok(method.source.text.includes("getIntent()"));
assert.ok(method.source.text.includes("setListAdapter"));
assert.equal(method.method.dex_descriptor, null);
const references = cliResults.get("trace_android_references").normalized_result;
assert.ok(references.total > 0);
assert.ok(
  references.references.every(
    (reference) =>
      reference.dex_offset === null && reference.source_line === null,
  ),
);
await verifyAndroidCliCancellation({
  entrypoint,
  environment,
  path,
  repository,
  execute,
});
assert.equal(
  await hashAndroidFile(apk),
  fixture.sha256,
  "Original APK must remain unchanged",
);
const report = {
  lane: "real-android",
  platform: process.platform,
  fixture: { version: fixture.version, sha256: fixture.sha256 },
  engine: packageResult.engine,
  operations: tasks.map((task) => task.name),
  cli_mcp_parity: true,
  original_apk_unchanged: true,
  apk_executed: false,
  cli_sigterm_cleanup: true,
  metadata_without_code_generation: true,
  stable_overload_selection: true,
};
if (process.env.REA_ANDROID_REPORT !== undefined)
  await writeFile(
    process.env.REA_ANDROID_REPORT,
    JSON.stringify(report, null, 2) + "\n",
  );
console.log(JSON.stringify(report, null, 2));
