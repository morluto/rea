import assert from "node:assert/strict";
import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { major } from "semver";
import { parseApktoolVersionOutput } from "../../dist/apktool/ApktoolConfiguration.js";
import { toolContract } from "../../dist/contracts/toolContracts.js";
import { hashStableFile } from "../../dist/filesystem/StableFileHash.js";
import { ArtifactResourceScope } from "../../dist/artifacts/ArtifactResourceScope.js";
import { OwnedCommandFailure } from "../../dist/process/OwnedCommand.js";
import {
  ExperimentCommandCleanupFailure,
  withCommands,
} from "../command-scope.mjs";

const { values } = parseArgs({
  options: {
    aapt2: { type: "string" },
    apktool: { type: "string" },
    framework: { type: "string" },
    output: { type: "string" },
  },
});
for (const name of ["aapt2", "apktool", "framework", "output"])
  if (!values[name]) throw new Error(`Missing --${name}`);
const output = resolve(values.output);
await mkdir(output); // Existing destinations are never overwritten.
const fixture = resolve(import.meta.dirname, "fixture");
const commands = [];
const files = new ArtifactResourceScope();
// Facts are added only after they are observed, so early failures retain the
// selected inputs without inventing a framework/source identity or tool result.
const receipt = {
  scope: "unshipped prototype",
  outcome: "running",
  output: { selected_path: values.output, path: output },
  fixture_path: fixture,
  framework: {
    selected_path: values.framework,
    path: resolve(values.framework),
  },
  tools: { aapt2: values.aapt2, apktool: values.apktool },
  signing: "not_performed",
  commands,
};
const failureRecord = (
  cause,
  { diagnostics = true, seen = new Set() } = {},
) => {
  if (!(cause instanceof Error)) return { message: String(cause) };
  const record = { name: cause.name, message: cause.message };
  if (seen.has(cause)) return { ...record, already_recorded: true };
  seen.add(cause);
  if (cause instanceof OwnedCommandFailure) {
    // The command owner has already bounded and interpreted these facts. Never
    // serialize its live cleanup owner or ambient child environment.
    Object.assign(record, {
      reason: cause.reason,
      snapshot:
        diagnostics || cause.snapshot === null
          ? cause.snapshot
          : {
              exitCode: cause.snapshot.exitCode,
              signal: cause.snapshot.signal,
            },
      collection_failure: cause.collectionFailure,
      cleanup_failure: cause.cleanupFailure,
      ...(cause.cleanupResult === undefined
        ? {}
        : { cleanup_result: cause.cleanupResult }),
      resources: cause.resources,
    });
  }
  if (cause instanceof ExperimentCommandCleanupFailure)
    record.cleanup_result = cause.result;
  if ("code" in cause && ["string", "number"].includes(typeof cause.code))
    record.code = cause.code;
  if (cause instanceof AggregateError)
    record.errors = cause.errors.map((error) =>
      failureRecord(error, { diagnostics, seen }),
    );
  if (cause.cause !== undefined)
    record.cause = failureRecord(cause.cause, { diagnostics, seen });
  return record;
};
const env = {
  ...process.env,
  REA_APKTOOL_COMMAND: resolve(values.apktool),
  JAVA_TOOL_OPTIONS: "-Xmx512m",
};
await withCommands(async (run, signal) => {
  const identity = (path) =>
    files.run(() =>
      hashStableFile(path, {
        signal,
        retainFailedClose: (handle) =>
          files.retain({ kind: "file-handle", resource: path, handle }),
      }),
    );
  const tree = async (path, prefix = "") => {
    const entries = [];
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory())
        entries.push(
          ...(await tree(join(path, entry.name), prefix + entry.name + "/")),
        );
      else {
        assert(entry.isFile());
        entries.push({
          path: prefix + entry.name,
          ...(await identity(join(path, entry.name))),
        });
      }
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  };
  let failed = false;
  let primary;
  try {
    const before = await tree(fixture);
    receipt.source = before;
    Object.assign(receipt.framework, await identity(receipt.framework.path));
    const selectedFramework = receipt.framework;
    const command = async (binary, args, options = {}) => {
      const started = performance.now();
      try {
        const result = await run(binary, args, {
          environment: env,
          timeoutMs: 120_000,
          maxBytes: 4 * 1024 * 1024,
          ...options,
        });
        commands.push({
          binary,
          arguments: args,
          outcome: "completed",
          elapsed_ms: performance.now() - started,
          ...result,
        });
        return result;
      } catch (cause) {
        commands.push({
          binary,
          arguments: args,
          outcome: "failed",
          elapsed_ms: performance.now() - started,
          error: failureRecord(cause),
        });
        throw cause;
      }
    };
    const aapt2 = resolve(values.aapt2);
    const apktool = resolve(values.apktool);
    const version = await command(aapt2, ["version"]);
    const observations = ["stdout", "stderr"].flatMap((channel) =>
      [
        ...version[channel].matchAll(
          /^Android Asset Packaging Tool \(aapt\) ([^\r\n]+)$/gmu,
        ),
      ]
        .map((match) => ({ channel, version: match[1].trim() }))
        .filter((entry) => entry.version.length > 0),
    );
    receipt.version_observations = observations;
    receipt.version =
      new Set(observations.map((entry) => entry.version)).size === 1
        ? observations[0].version
        : null;
    const apktoolVersion = parseApktoolVersionOutput(
      (await command(apktool, ["--version"])).stdout,
    );
    receipt.apktool_identity = apktoolVersion;
    receipt.apktool_version = apktoolVersion.version;
    const family =
      apktoolVersion.version === null ? null : major(apktoolVersion.version);
    receipt.apktool_build_family =
      apktoolVersion.supportsDocumentedVersion && [2, 3].includes(family)
        ? family
        : null;
    assert.notEqual(
      receipt.apktool_build_family,
      null,
      "Fixture rebuild requires a recognized Apktool 2.7+ or 3.x version; no build protocol was selected",
    );
    const source = join(output, "source");
    await cp(fixture, source, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const compiled = join(output, "compiled.zip");
    const apk = join(output, "linked.apk");
    await command(aapt2, [
      "compile",
      "--dir",
      join(source, "res"),
      "-o",
      compiled,
    ]);
    await command(aapt2, [
      "link",
      "-I",
      selectedFramework.path,
      "--manifest",
      join(source, "AndroidManifest.xml"),
      "-o",
      apk,
      compiled,
    ]);
    const linked = await identity(apk);
    receipt.linked = linked;
    const dumps = {};
    receipt.dumps = dumps;
    for (const kind of ["badging", "resources", "strings", "configurations"])
      dumps[kind] = (await command(aapt2, ["dump", kind, apk])).stdout;
    dumps.xmltree = (
      await command(aapt2, [
        "dump",
        "xmltree",
        "--file",
        "res/layout/main.xml",
        apk,
      ])
    ).stdout;
    assert.match(
      dumps.badging,
      /package: name='com\.rea\.aapt2\.probe'.*versionCode='7'.*versionName='1\.2\.3'/u,
    );
    assert.match(dumps.resources, /string\/greeting/u);
    assert.match(dumps.strings, /Hello & welcome/u);
    assert.match(dumps.strings, /Hallo & willkommen/u);
    assert.match(dumps.xmltree, /TextView/u);
    const decoded = join(output, "decoded");
    const frames = join(output, "framework-cache");
    await command(apktool, ["d", "--no-src", "-p", frames, "-o", decoded, apk]);
    const decodedBefore = await tree(decoded);
    const rebuildSource = join(output, "rebuild-source");
    await cp(decoded, rebuildSource, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const rebuilt = join(output, "rebuilt.apk");
    await command(apktool, [
      "b",
      ...(family === 2 ? ["--use-aapt2"] : []),
      "--aapt",
      aapt2,
      "-p",
      frames,
      "-o",
      rebuilt,
      rebuildSource,
    ]);
    const rebuiltIdentity = await identity(rebuilt);
    receipt.rebuilt = rebuiltIdentity;
    const rebuiltStrings = (await command(aapt2, ["dump", "strings", rebuilt]))
      .stdout;
    assert.match(rebuiltStrings, /Hello & welcome/u);
    assert.match(rebuiltStrings, /Hallo & willkommen/u);
    const badDirectory = join(output, "bad-res", "values");
    await mkdir(badDirectory, { recursive: true });
    const bad = join(badDirectory, "strings.xml");
    await writeFile(bad, '<resources><string name="broken">');
    const invalid = await command(
      aapt2,
      ["compile", bad, "-o", join(output, "invalid.zip")],
      { acceptNonZeroExit: true },
    );
    assert.notEqual(invalid.code, 0);
    receipt.malformed_resource_refused = true;
    const missing = await command(
      aapt2,
      [
        "link",
        "-I",
        join(output, "absent.jar"),
        "--manifest",
        join(source, "AndroidManifest.xml"),
        "-o",
        join(output, "missing.apk"),
        compiled,
      ],
      { acceptNonZeroExit: true },
    );
    assert.notEqual(missing.code, 0);
    receipt.missing_framework_refused = true;
    const cli = await command(process.execPath, [
      resolve("scripts/rea.mjs"),
      "decode-android-resources",
      apk,
      "--json",
    ]);
    const cliEvidence = toolContract(
      "decode_android_resources",
    ).outputSchema.parse(JSON.parse(cli.stdout));
    const client = new Client({ name: "aapt2-scope-probe", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      env: Object.fromEntries(
        Object.entries(env).filter(([, value]) => typeof value === "string"),
      ),
      stderr: "pipe",
    });
    transport.stderr?.resume();
    let mcpFailed = false;
    let mcpPrimary;
    try {
      await client.connect(transport, { timeout: 120_000, signal });
      const reply = await client.callTool(
        { name: "decode_android_resources", arguments: { path: apk } },
        { timeout: 120_000, signal },
      );
      assert.notEqual(reply.isError, true, JSON.stringify(reply));
      const text = reply.content.find((part) => part.type === "text")?.text;
      const mcp = toolContract("decode_android_resources").outputSchema.parse(
        reply.structuredContent ?? JSON.parse(text),
      );
      assert.deepEqual(mcp.normalized_result, cliEvidence.normalized_result);
      assert.deepEqual(mcp.subject, cliEvidence.subject);
      receipt.existing_decode_cli_mcp_parity = true;
    } catch (cause) {
      mcpFailed = true;
      mcpPrimary = cause;
    }
    const mcpCleanup = [];
    for (const close of [() => client.close(), () => transport.close()]) {
      try {
        await close();
      } catch (cause) {
        mcpCleanup.push(cause);
      }
    }
    if (mcpCleanup.length > 0)
      throw new AggregateError(
        [...(mcpFailed ? [mcpPrimary] : []), ...mcpCleanup],
        "MCP verification cleanup failed",
        { cause: mcpPrimary },
      );
    if (mcpFailed) throw mcpPrimary;
    assert.deepEqual(await tree(fixture), before);
    assert.deepEqual(await tree(decoded), decodedBefore);
    assert.deepEqual(await identity(apk), linked);
    assert.deepEqual(await identity(rebuilt), rebuiltIdentity);
    assert.deepEqual(await identity(selectedFramework.path), {
      bytes: selectedFramework.bytes,
      sha256: selectedFramework.sha256,
    });
    Object.assign(receipt, {
      tokens: "unmeasured",
      process_family_peak: "unmeasured",
    });
  } catch (cause) {
    failed = true;
    primary = cause;
  }
  try {
    await files.close();
  } catch (cleanup) {
    if (failed)
      throw new AggregateError(
        [primary, cleanup],
        "Verification and file cleanup failed",
        { cause: primary },
      );
    throw cleanup;
  }
  if (failed) throw primary;
})
  .then(async () => {
    receipt.outcome = "completed";
    await writeFile(
      join(output, "receipt.json"),
      JSON.stringify(receipt, null, 2),
    );
    console.log(
      "AAPT2 prototype: inspection, compile/link, caller-selected Apktool rebuild, negative inputs and existing decode CLI/MCP parity passed",
    );
  })
  .catch(async (cause) => {
    receipt.outcome = "failed";
    receipt.failure = failureRecord(cause);
    receipt.retained_file_resources = files.cleanupResources;
    let published = false;
    try {
      await writeFile(
        join(output, "receipt.json"),
        JSON.stringify(receipt, null, 2),
      );
      published = true;
    } catch (publication) {
      cause = new AggregateError(
        [cause, publication],
        "Verification and failure-receipt publication failed",
        { cause },
      );
    }
    // Node's uncaught-error inspector is not a publication boundary: cleanup
    // errors may carry live owners. Keep bounded producer output in the receipt,
    // not expanded again through stderr and every parent command's capture.
    process.stderr.write(
      JSON.stringify({
        outcome: "failed",
        receipt_path: join(output, "receipt.json"),
        receipt_published: published,
        failure: failureRecord(cause, { diagnostics: false }),
      }) + "\n",
    );
    process.exitCode = 1;
  });
