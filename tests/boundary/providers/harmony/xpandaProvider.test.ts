import { access, constants, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it as test, onTestFinished } from "vitest";

import { AnalysisError } from "../../../../src/domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisTimeoutError,
} from "../../../../src/domain/analysisErrorCore.js";
import type { HarmonyAbcRequest } from "../../../../src/domain/harmony/harmonyAbcAnalysis.js";
import {
  fakeXpandaCalls,
  setFakeXpandaBehavior,
  tempRoot,
  xpandaFixture,
  type XpandaFixture,
} from "./xpandaFixture.js";

const it = test.skipIf(process.platform === "win32");

const run = async (
  fixture: XpandaFixture,
  request: HarmonyAbcRequest,
  signal?: AbortSignal,
) => {
  const result = await fixture.provider.execute(
    request,
    signal === undefined ? {} : { signal },
  );
  if (!result.ok) throw result.error;
  return result.value;
};

const targetOf = (fixture: XpandaFixture) => ({
  path: fixture.targetPath,
});

it("inspects a staged snapshot and closes the producer session", async () => {
  const fixture = await xpandaFixture();
  onTestFinished(() => fixture.provider.close().catch(() => undefined));
  const execution = await run(fixture, {
    operation: "inspect_harmony_abc",
    input: { path: fixture.targetPath },
  });
  expect(execution.result).toMatchObject({
    input_size: 8016,
    bytecode_version: "11.0.2.0",
    checksum: "0x5411df7",
    class_count: 2,
    coverage: "header",
  });
  expect(execution.subject).toMatchObject({
    path: fixture.targetPath,
    format: "abc",
  });
  expect(execution.provider).toMatchObject({
    id: "xpanda",
    version: "2.1.0",
  });
  const calls = (execution.rawResult as { calls: { operation: string }[] })
    .calls;
  expect(calls[0]?.operation).toBe("abc_load");
  expect(calls.at(-1)?.operation).toBe("abc_close");
  const evidence = execution;
  expect(evidence.subject).toMatchObject({ format: "abc" });
  // The producer saw a private staged copy, not the caller's path.
  const stagedPath = (execution.rawResult as { load: { path: string } }).load
    .path;
  expect(stagedPath).not.toBe(fixture.targetPath);
  expect(stagedPath.endsWith("input.abc")).toBe(true);
  const calls_log = await fakeXpandaCalls(fixture.callsPath);
  expect(calls_log.map(({ method }) => method)).toEqual([
    "initialize",
    "tools/call",
    "tools/list",
    "tools/call",
  ]);
});

it("executes every named operation against the producer surface", async () => {
  const fixture = await xpandaFixture();
  onTestFinished(() => fixture.provider.close().catch(() => undefined));
  const output = join(await tempRoot(), "exported");
  const operations: HarmonyAbcRequest[] = [
    { operation: "inspect_harmony_abc", input: targetOf(fixture) },
    {
      operation: "list_harmony_abc_classes",
      input: { ...targetOf(fixture), filter: "_GLOBAL", offset: 0, limit: 50 },
    },
    {
      operation: "decompile_harmony_abc_class",
      input: { ...targetOf(fixture), class_name: "_GLOBAL", simplify: true },
    },
    {
      operation: "decompile_harmony_abc",
      input: { ...targetOf(fixture), output_directory: output, simplify: true },
    },
    {
      operation: "disassemble_harmony_abc_method",
      input: {
        ...targetOf(fixture),
        class_name: "_GLOBAL",
        max_instructions: 1500,
      },
    },
    {
      operation: "search_harmony_abc_strings",
      input: {
        ...targetOf(fixture),
        pattern: "md5",
        regex: false,
        offset: 0,
        limit: 100,
      },
    },
    {
      operation: "inspect_harmony_abc_class",
      input: { ...targetOf(fixture), class_name: "_GLOBAL" },
    },
    {
      operation: "decompile_harmony_abc_method",
      input: {
        ...targetOf(fixture),
        class_name: "_GLOBAL",
        method_name: "func_main_0",
        simplify: true,
      },
    },
    {
      operation: "search_harmony_abc_symbols",
      input: {
        ...targetOf(fixture),
        query: "main",
        kind: "all",
        regex: false,
        case_sensitive: false,
        include_external: true,
        offset: 0,
        limit: 50,
      },
    },
    {
      operation: "search_harmony_abc_code",
      input: {
        ...targetOf(fixture),
        pattern: "md5",
        regex: false,
        case_sensitive: false,
        simplify: true,
        max_classes: 100,
        context_lines: 0,
        offset: 0,
        limit: 50,
      },
    },
    {
      operation: "trace_harmony_abc_references",
      input: {
        ...targetOf(fixture),
        target_type: "class",
        target: "_GLOBAL",
        source: false,
        max_classes: 200,
        offset: 0,
        limit: 50,
      },
    },
    {
      operation: "build_harmony_abc_call_graph",
      input: {
        ...targetOf(fixture),
        class_name: "_GLOBAL",
        method_name: "func_main_0",
        direction: "both",
        depth: 2,
        max_nodes: 200,
        max_classes: 200,
        simplify: true,
        format: "json",
      },
    },
  ];
  for (const request of operations) {
    const execution = await run(fixture, request);
    expect(execution.result).toMatchObject({ coverage: expect.any(String) });
  }
  // The fake engine created the export directory as the producer would.
  await access(join(output, "_GLOBAL.js"), constants.R_OK);
  const calls = await fakeXpandaCalls(fixture.callsPath);
  expect(calls.filter(({ method }) => method === "initialize")).toHaveLength(1);
});

it("inspects a .hap entry and its resources against the producer surface", async () => {
  const fixture = await xpandaFixture({ hap: true });
  onTestFinished(() => fixture.provider.close().catch(() => undefined));
  const entry = await run(fixture, {
    operation: "inspect_harmony_hap_abc",
    input: {
      path: fixture.targetPath,
      entry: "ets/modules.abc",
    },
  });
  expect(entry.result).toMatchObject({
    entry: "ets/modules.abc",
    runtime: "dynamic",
    class_count: 2,
    coverage: "hap_entry",
  });
  expect(entry.subject).toMatchObject({ format: "hap" });
  const resources = await run(fixture, {
    operation: "inspect_harmony_hap_resources",
    input: {
      path: fixture.targetPath,
      name: "app",
      offset: 0,
      limit: 50,
    },
  });
  expect(resources.result).toMatchObject({
    format: "RestoolV2",
    matched: 1,
    resources: [
      { id: "0x03000003", name: "app_name", resource_type: "string" },
    ],
    coverage: "hap_resources",
  });
});

it("refuses an existing export directory without calling the producer", async () => {
  const fixture = await xpandaFixture();
  onTestFinished(() => fixture.provider.close().catch(() => undefined));
  const result = await fixture.provider.execute({
    operation: "decompile_harmony_abc",
    input: {
      path: fixture.targetPath,
      output_directory: fixture.root,
      simplify: true,
    },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisInputError);
  expect((result.error as AnalysisInputError).issues[0]?.path).toEqual([
    "output_directory",
  ]);
  // No producer call was made for a refused destination.
  expect(
    (await fakeXpandaCalls(fixture.callsPath)).filter(
      ({ method }) => method === "tools/call",
    ),
  ).toEqual([]);
});

it("maps producer input errors without poisoning the retained bridge", async () => {
  const fixture = await xpandaFixture({
    abc_decompile_class: "error",
  });
  onTestFinished(() => fixture.provider.close().catch(() => undefined));
  const failure = await fixture.provider
    .execute({
      operation: "decompile_harmony_abc_class",
      input: {
        path: fixture.targetPath,
        class_name: "NoSuchClass",
        simplify: true,
      },
    })
    .then((result) => (result.ok ? undefined : result.error));
  expect(failure).toBeInstanceOf(AnalysisInputError);
  expect((failure as AnalysisInputError).issues[0]?.path).toEqual([
    "class_name",
  ]);
  // The producer answered coherently, so the bridge stays and the next
  // operation must not pay for a restart.
  await setFakeXpandaBehavior(fixture.behaviorPath, {});
  const execution = await run(fixture, {
    operation: "list_harmony_abc_classes",
    input: { path: fixture.targetPath, offset: 0, limit: 50 },
  });
  const calls = await fakeXpandaCalls(fixture.callsPath);
  expect(calls.filter(({ method }) => method === "initialize")).toHaveLength(1);
  expect(execution.result).toMatchObject({ total_classes: 2 });
});

it("maps an unparseable target to the selected path", async () => {
  const fixture = await xpandaFixture({ load: "badmagic" });
  onTestFinished(() => fixture.provider.close().catch(() => undefined));
  const failure = await fixture.provider
    .execute({
      operation: "inspect_harmony_abc",
      input: { path: fixture.targetPath },
    })
    .then((result) => (result.ok ? undefined : result.error));
  expect(failure).toBeInstanceOf(AnalysisInputError);
  expect((failure as AnalysisInputError).issues[0]?.path).toEqual(["path"]);
  expect((failure as AnalysisError).cleanupIncomplete).toBe(false);
});

it("reports the unimplemented-instruction boundary as a capability limit", async () => {
  const fixture = await xpandaFixture({ abc_disassemble_method: "error" });
  onTestFinished(() => fixture.provider.close().catch(() => undefined));
  const failure = await fixture.provider
    .execute({
      operation: "disassemble_harmony_abc_method",
      input: {
        path: fixture.targetPath,
        class_name: "_GLOBAL",
        max_instructions: 1500,
      },
    })
    .then((result) => (result.ok ? undefined : result.error));
  expect(failure).toBeInstanceOf(AnalysisCapabilityUnavailableError);
  expect(
    (failure as AnalysisCapabilityUnavailableError).remediationAction,
  ).toContain("degraded");
});

it("cancels a hung producer call and stops the owned bridge", async () => {
  const fixture = await xpandaFixture({ load: "hang" });
  onTestFinished(() => fixture.provider.close().catch(() => undefined));
  const caller = new AbortController();
  const pending = fixture.provider.execute(
    {
      operation: "inspect_harmony_abc",
      input: { path: fixture.targetPath },
    },
    { signal: caller.signal },
  );
  await expect
    .poll(async () => (await fakeXpandaCalls(fixture.callsPath)).length)
    .toBeGreaterThan(0);
  caller.abort(new Error("caller changed their mind"));
  const failure = await pending.then((result) =>
    result.ok ? undefined : result.error,
  );
  expect(failure).toBeInstanceOf(AnalysisCancelledError);
  expect((failure as AnalysisError).cause).toBeInstanceOf(Error);
  // The bridge is retired after a fatal hang: its process must be gone.
  const pid = Number((await fakeXpandaCalls(fixture.callsPath))[0]?.pid);
  await expect
    .poll(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
  // A fresh bridge serves the next caller.
  await setFakeXpandaBehavior(fixture.behaviorPath, {});
  const execution = await run(fixture, {
    operation: "inspect_harmony_abc",
    input: { path: fixture.targetPath },
  });
  expect(execution.result).toMatchObject({ class_count: 2 });
});

it("applies the operation deadline to a hung producer", async () => {
  const fixture = await xpandaFixture({ load: "hang" });
  onTestFinished(() => fixture.provider.close().catch(() => undefined));
  const failure = await fixture.provider
    .execute({
      operation: "inspect_harmony_abc",
      input: { path: fixture.targetPath, analysis_timeout_ms: 400 },
    })
    .then((result) => (result.ok ? undefined : result.error));
  expect(failure).toBeInstanceOf(AnalysisTimeoutError);
  expect((failure as AnalysisTimeoutError).timeoutMs).toBe(400);
});

it("retires an idle bridge and serves the next caller from a fresh one", async () => {
  const fixture = await xpandaFixture({}, { idleRetireMs: 100 });
  onTestFinished(() => fixture.provider.close().catch(() => undefined));
  await run(fixture, {
    operation: "inspect_harmony_abc",
    input: { path: fixture.targetPath },
  });
  const firstPid = Number((await fakeXpandaCalls(fixture.callsPath))[0]?.pid);
  // Idle retirement stops the owned producer process without a close call.
  await expect
    .poll(() => {
      try {
        process.kill(firstPid, 0);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(false);
  const execution = await run(fixture, {
    operation: "inspect_harmony_abc",
    input: { path: fixture.targetPath },
  });
  expect(execution.result).toMatchObject({ class_count: 2 });
  const calls = await fakeXpandaCalls(fixture.callsPath);
  expect(calls.filter(({ method }) => method === "initialize")).toHaveLength(2);
});

it("refuses work after close and stays idempotent", async () => {
  const fixture = await xpandaFixture();
  await expect(fixture.provider.close()).resolves.toBeUndefined();
  await expect(fixture.provider.close()).resolves.toBeUndefined();
  const failure = await fixture.provider
    .execute({
      operation: "inspect_harmony_abc",
      input: { path: fixture.targetPath },
    })
    .then((result) => (result.ok ? undefined : result.error));
  expect(failure).toBeInstanceOf(AnalysisCancelledError);
});

it("records an unverified-version limitation without refusing 2.x", async () => {
  const fixture = await xpandaFixture({}, { version: "2.9.0" });
  onTestFinished(() => fixture.provider.close().catch(() => undefined));
  const execution = await run(fixture, {
    operation: "inspect_harmony_abc",
    input: { path: fixture.targetPath },
  });
  expect(execution.provider).toMatchObject({ version: "2.9.0" });
  expect(execution.limitations.join("\n")).toContain("unverified");
});

it("refuses an unconfigured environment with the documented remediation", async () => {
  const provider = new (
    await import("../../../../src/harmony/XpandaProvider.js")
  ).XpandaProvider({});
  const failure = await provider
    .execute({
      operation: "inspect_harmony_abc",
      input: { path: "/rea-absent/module.abc" },
    })
    .then((result) => (result.ok ? undefined : result.error));
  expect(failure).toBeInstanceOf(AnalysisCapabilityUnavailableError);
  expect(
    (failure as AnalysisCapabilityUnavailableError).remediationAction,
  ).toContain("REA_XPANDA_ROOT");
});

it("cites only the producer calls of the current operation", async () => {
  const fixture = await xpandaFixture();
  onTestFinished(() => fixture.provider.close().catch(() => undefined));
  await run(fixture, {
    operation: "inspect_harmony_abc",
    input: { path: fixture.targetPath },
  });
  const second = await run(fixture, {
    operation: "list_harmony_abc_classes",
    input: {
      path: fixture.targetPath,
      filter: "_GLOBAL",
      offset: 0,
      limit: 50,
    },
  });
  const calls = (
    second.rawResult as { calls: { operation: string }[] }
  ).calls.map(({ operation }) => operation);
  expect(calls).toEqual(["abc_load", "abc_list_classes", "abc_close"]);
});

it("publishes exports from the private root and refuses escaped files", async () => {
  const fixture = await xpandaFixture();
  onTestFinished(() => fixture.provider.close().catch(() => undefined));
  const destination = join(await tempRoot(), "nested", "published");
  const execution = await run(fixture, {
    operation: "decompile_harmony_abc",
    input: {
      path: fixture.targetPath,
      output_directory: destination,
      simplify: true,
    },
  });
  expect(execution.result).toMatchObject({
    output_directory: destination,
    written: 1,
  });
  await access(join(destination, "_GLOBAL.js"), constants.R_OK);

  await setFakeXpandaBehavior(fixture.behaviorPath, { abc_export: "escape" });
  const escapedDestination = join(await tempRoot(), "escaped");
  const failure = await fixture.provider
    .execute({
      operation: "decompile_harmony_abc",
      input: {
        path: fixture.targetPath,
        output_directory: escapedDestination,
        simplify: true,
      },
    })
    .then((result) => (result.ok ? undefined : result.error));
  expect(failure).toBeInstanceOf(AnalysisOutputError);
  await expect(access(escapedDestination)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("keeps completed load facts when a later tool fails", async () => {
  const fixture = await xpandaFixture({ abc_list_classes: "error" });
  onTestFinished(() => fixture.provider.close().catch(() => undefined));
  const failure = await fixture.provider
    .execute({
      operation: "list_harmony_abc_classes",
      input: {
        path: fixture.targetPath,
        filter: "_GLOBAL",
        offset: 0,
        limit: 50,
      },
    })
    .then((result) => (result.ok ? undefined : result.error));
  expect(failure).toBeInstanceOf(AnalysisError);
  expect((failure as AnalysisError).partialObservation).toMatchObject({
    kind: "harmony-abc",
    provenance: { load: { fileId: "md5-5411df7" } },
  });
});

it("refuses a non-regular selected path before starting the producer", async () => {
  const fixture = await xpandaFixture();
  onTestFinished(() => fixture.provider.close().catch(() => undefined));
  const directory = join(fixture.root, "directory-input");
  await mkdir(directory);
  const failure = await fixture.provider
    .execute({
      operation: "inspect_harmony_abc",
      input: { path: directory },
    })
    .then((result) => (result.ok ? undefined : result.error));
  expect(failure).toBeInstanceOf(AnalysisInputError);
  expect((failure as AnalysisInputError).issues[0]?.path).toEqual(["path"]);
  expect(
    (await fakeXpandaCalls(fixture.callsPath)).filter(
      ({ method }) => method === "initialize",
    ),
  ).toEqual([]);
});

it("keeps the bridge when an idle deadline elapses during a request", async () => {
  const fixture = await xpandaFixture({}, { idleRetireMs: 100 });
  onTestFinished(() => fixture.provider.close().catch(() => undefined));
  await run(fixture, {
    operation: "inspect_harmony_abc",
    input: { path: fixture.targetPath },
  });
  await setFakeXpandaBehavior(fixture.behaviorPath, { load: "slow" });
  await run(fixture, {
    operation: "list_harmony_abc_classes",
    input: {
      path: fixture.targetPath,
      filter: "_GLOBAL",
      offset: 0,
      limit: 50,
    },
  });
  await setFakeXpandaBehavior(fixture.behaviorPath, {});
  await run(fixture, {
    operation: "inspect_harmony_abc",
    input: { path: fixture.targetPath },
  });
  const calls = await fakeXpandaCalls(fixture.callsPath);
  expect(calls.filter(({ method }) => method === "initialize")).toHaveLength(1);
});
