import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveAdbBinary } from "../../dist/adb/AdbConfiguration.js";
import { snapshotAndroidTarget } from "../../dist/android/AndroidTargetSnapshot.js";
import { toolContract } from "../../dist/contracts/toolContracts.js";
import { PROPOSED_ADB_UI_ACTION_CONTRACT } from "../../dist/contracts/adb/adbUiToolContracts.js";
import { hashStableFile } from "../../dist/filesystem/StableFileHash.js";
import { ArtifactResourceScope } from "../../dist/artifacts/ArtifactResourceScope.js";
import { acquireFixtureLease } from "./lease.mjs";

export const FIXTURE_PACKAGE = "com.rea.ui.probe";
export const MIRROR_FIXTURE_PACKAGE = "com.rea.ui.mirror";
export const REA_CLI_PATH = resolve(
  import.meta.dirname,
  "../../scripts/rea.mjs",
);
export const UI_EXPERIMENT_MCP_PATH = resolve(import.meta.dirname, "mcp.mjs");
const REQUEST_MS = 120_000;

/** Own the admitted APK, installation attempt and MCP session through cleanup. */
export async function withFixture(
  {
    apk,
    aapt2,
    output,
    serial,
    environment,
    client,
    transport,
    run,
    signal,
    settleCommands,
    leaseDirectory,
    expectedPackage = FIXTURE_PACKAGE,
    hashFile = hashStableFile,
  },
  work,
) {
  const files = new ArtifactResourceScope();
  const hash = (path) =>
    files.run(() =>
      hashFile(path, {
        signal,
        retainFailedClose: (handle) =>
          files.retain({ kind: "file-handle", resource: path, handle }),
      }),
    );
  const invoke = async (name, input, requestSignal) => {
    requestSignal.throwIfAborted();
    const reply = await client.callTool(
      { name, arguments: input },
      { timeout: REQUEST_MS, signal: requestSignal },
    );
    assert.notEqual(reply.isError, true, JSON.stringify(reply));
    const text = reply.content.find((part) => part.type === "text")?.text;
    const contract =
      name === PROPOSED_ADB_UI_ACTION_CONTRACT.name
        ? PROPOSED_ADB_UI_ACTION_CONTRACT
        : toolContract(name);
    return contract.outputSchema.parse(
      reply.structuredContent ?? JSON.parse(text),
    );
  };
  const call = (name, input) => invoke(name, input, signal);
  const inventory = async (packageName, requestSignal) => {
    const evidence = await invoke(
      "resolve_adb_packages",
      { serial, query: packageName },
      requestSignal,
    );
    assert.equal(
      evidence.normalized_result.coverage,
      "complete",
      "Fixture package inventory is incomplete; absence is unknown",
    );
    return {
      evidence,
      present: evidence.normalized_result.matches.some(
        (entry) => entry.package_name === packageName,
      ),
    };
  };
  let owner;
  let lease;
  let value;
  let failed = false;
  let primary;
  const cleanupPath = join(output, "fixture-cleanup.json");
  try {
    assert(
      [FIXTURE_PACKAGE, MIRROR_FIXTURE_PACKAGE].includes(expectedPackage),
      "Unknown UI verification fixture package",
    );
    const selection = resolveAdbBinary(environment);
    const adb = (args) =>
      run(selection.binary, ["-s", serial, ...args], {
        environment,
      });
    await client.connect(transport, { timeout: REQUEST_MS, signal });
    // Inspect a private snapshot, then install those same bytes. Replacement of
    // the caller's path cannot change which manifest package is installed.
    const admitted = {
      path: resolve(apk),
      ...(await hash(apk)),
    };
    const snapshotRoot = join(output, "fixture");
    await mkdir(snapshotRoot, { mode: 0o700 });
    const snapshot = await snapshotAndroidTarget(
      admitted.path,
      admitted.sha256,
      snapshotRoot,
      "inspect_android_package",
      signal,
    );
    // AAPT2 reads the binary manifest even when the fixture has no resources;
    // a full resource decoder need not support such an APK.
    const arguments_ = ["dump", "packagename", snapshot];
    const captured = await run(aapt2, arguments_, { environment });
    const packageName = captured.stdout.trim();
    assert.equal(
      packageName,
      expectedPackage,
      "Selected APK is not the UI fixture package",
    );
    assert.deepEqual(await hash(snapshot), {
      sha256: admitted.sha256,
      bytes: admitted.bytes,
    });
    const inspection = {
      binary: aapt2,
      arguments: arguments_,
      ...captured,
      package: packageName,
      sha256: admitted.sha256,
    };
    assert.equal(
      (await adb(["shell", "getprop", "ro.kernel.qemu"])).stdout.trim(),
      "1",
      "This experiment requires an emulator",
    );
    lease = await acquireFixtureLease({
      serial,
      packageName,
      output,
      directory: leaseDirectory,
    });
    const initial = await inventory(packageName, signal);
    assert.equal(
      initial.present,
      false,
      "The fixture package must not already be installed",
    );
    signal.throwIfAborted();
    const candidate = {
      serial,
      package: packageName,
      apk_path: snapshot,
      source: admitted,
      inspection,
      initially_absent: initial.evidence,
      lease: { path: lease.path, ...lease.record },
    };
    await writeFile(
      cleanupPath,
      JSON.stringify(
        { status: "install-attempted", owner: candidate },
        null,
        2,
      ),
      { flag: "wx" },
    );
    owner = candidate;
    const cli = await run(
      process.execPath,
      [REA_CLI_PATH, "install-adb-package", serial, snapshot, "--json"],
      { timeoutMs: REQUEST_MS, environment },
    );
    const installation = toolContract("install_adb_package").outputSchema.parse(
      JSON.parse(cli.stdout),
    );
    assert.equal(
      installation.normalized_result.sha256,
      admitted.sha256,
      "Installed APK identity changed",
    );
    value = await work({ call, adb, installation, fixture: owner });
  } catch (cause) {
    failed = true;
    primary = cause;
  }

  const failures = [];
  const cleanupResources = new Set();
  let commandsSettled = false;
  try {
    await settleCommands();
    commandsSettled = true;
  } catch (cause) {
    failures.push(cause);
  }
  if (owner && commandsSettled) {
    try {
      // Workflow cancellation must not cancel reconciliation or uninstall. One
      // fresh deadline bounds the entire device-cleanup sequence.
      const cleanupSignal = AbortSignal.timeout(REQUEST_MS);
      let remaining = await inventory(owner.package, cleanupSignal);
      if (remaining.present) {
        await invoke(
          "uninstall_adb_package",
          { serial: owner.serial, package: owner.package },
          cleanupSignal,
        );
        remaining = await inventory(owner.package, cleanupSignal);
      }
      assert.equal(remaining.present, false, "Fixture package cleanup failed");
      const removed = owner;
      owner = undefined;
      await writeFile(
        cleanupPath,
        JSON.stringify(
          { status: "absent", owner: removed, evidence: remaining.evidence },
          null,
          2,
        ),
      );
    } catch (cause) {
      failures.push(cause);
    }
  }
  for (const resource of [files, client, transport]) {
    try {
      await resource.close();
    } catch (cause) {
      failures.push(cause);
      cleanupResources.add(resource);
    }
  }
  if (lease && commandsSettled && !owner && failures.length === 0) {
    try {
      await lease.release();
      lease = undefined;
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (lease) cleanupResources.add(lease);
  if (failures.length) {
    const error = new AggregateError(
      [...(failed ? [primary] : []), ...failures],
      "UI verification cleanup failed",
      { cause: primary },
    );
    // Keep the exact device/package and APK identity available for recovery.
    error.cleanupOwner = owner;
    error.cleanupLease = lease;
    error.cleanupResources = cleanupResources;
    throw error;
  }
  if (failed) throw primary;
  signal.throwIfAborted();
  return value;
}
