import { expect, it as test } from "vitest";
import { access, readFile, writeFile } from "node:fs/promises";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { AndroidAnalysisService } from "../../../src/application/AndroidAnalysisService.js";
import { JadxProvider } from "../../../src/android/JadxProvider.js";
import { androidResultSchemas } from "../../../src/domain/androidAnalysis.js";
import {
  createJadxProtocolFixture as setup,
  verifyJadxFixtureCleanup as verifyCleanup,
} from "../../fixtures/android/jadx.js";

const it = test.skipIf(process.platform === "win32");

it("does not carry a factory instance's cleanup failure into another instance", async () => {
  const failed = await setup("cleanup-failure");
  const healthy = await setup();
  const failure = await failed.service.execute("inspect_android_package", {
    path: failed.apk,
  });
  expect(failure).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  const result = await healthy.service.execute("inspect_android_package", {
    path: healthy.apk,
  });
  expect(result.ok).toBe(true);
  await verifyCleanup(healthy.launches);
});

it("retains APK identity, original input, raw producer data and normalized observations", async () => {
  const { service, apk, launches } = await setup();
  const outcome = await service.execute("inspect_android_package", {
    path: apk,
  });
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw outcome.error;
  const result = androidResultSchemas.inspect_android_package.parse(
    outcome.value.normalized_result,
  );
  expect(result.package_name).toBe("fixture");
  expect(result.engine.source_revision).toBeNull();
  expect(outcome.value.subject?.local_path).toBe(apk);
  expect(outcome.value.parameters).toEqual({ path: apk });
  expect(outcome.value.raw_result).toMatchObject({
    calls: expect.arrayContaining([
      expect.objectContaining({ operation: "get_android_manifest" }),
    ]),
  });
  await verifyCleanup(launches);
});

it("fetches all class pages rather than silently retaining the first upstream page", async () => {
  const { service, apk, launches } = await setup();
  const outcome = await service.execute("search_android_classes", {
    path: apk,
    query: "",
  });
  if (!outcome.ok) throw outcome.error;
  const result = androidResultSchemas.search_android_classes.parse(
    outcome.value.normalized_result,
  );
  expect(result.total_classes).toBe(401);
  expect(result.matches).toHaveLength(401);
  expect(result.matches.at(-1)).toBe("fixture.Class399");
  await verifyCleanup(launches);
});

it("exposes overload candidates and executes only an explicitly selected ambiguous method", async () => {
  const { service, apk, launches } = await setup();
  const input = {
    path: apk,
    class_name: "fixture.Target",
    method_name: "choose",
  };
  const ambiguous = await service.execute("inspect_android_method", input);
  expect(ambiguous).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisInputError",
      issues: [
        {
          path: ["overload_index"],
          message: expect.stringContaining("1: choose(int)"),
        },
      ],
    },
  });
  const selected = await service.execute("inspect_android_method", {
    ...input,
    overload_index: 1,
  });
  if (!selected.ok) throw selected.error;
  const result = androidResultSchemas.inspect_android_method.parse(
    selected.value.normalized_result,
  );
  expect(result.method).toMatchObject({
    overload_index: 1,
    reported_signature: "choose(int): void",
    dex_descriptor: null,
  });
  expect(result.source.text).toContain("overload 1");
  const references = await service.execute("trace_android_references", input);
  expect(references).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCapabilityUnavailableError",
      reason: expect.stringContaining("first same-name"),
    },
  });
  await verifyCleanup(launches);
});

it.each([
  "wrong-apk",
  "empty-page",
  "summary-error",
  "wrong-method",
  "body-error",
  "partial-xrefs",
])(
  "rejects producer failure %s rather than claiming complete analysis",
  async (mode) => {
    const { service, apk, launches } = await setup(mode);
    const operation =
      mode === "wrong-apk"
        ? "inspect_android_package"
        : mode === "empty-page"
          ? "search_android_classes"
          : mode === "partial-xrefs"
            ? "trace_android_references"
            : "inspect_android_method";
    const outcome = await service.execute(operation, {
      path: apk,
      ...(operation === "search_android_classes"
        ? { query: "" }
        : operation === "inspect_android_package"
          ? {}
          : { class_name: "fixture.Target", method_name: "onCreate" }),
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisOutputError" },
    });
    await verifyCleanup(launches);
  },
);

it("rejects fuzzy class resolution and unsupported upstream versions", async () => {
  for (const mode of ["wrong-class", "version"]) {
    const { service, apk, launches } = await setup(mode);
    const outcome = await service.execute("inspect_android_class", {
      path: apk,
      class_name: "fixture.Target",
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: {
        _tag:
          mode === "version"
            ? "AnalysisCapabilityUnavailableError"
            : "AnalysisInputError",
      },
    });
    await verifyCleanup(launches);
  }
});

it.each(["truncated", "smali"])(
  "retains %s source coverage instead of presenting it as successful complete Java",
  async (mode) => {
    const { service, apk, launches } = await setup(mode);
    const outcome = await service.execute("inspect_android_method", {
      path: apk,
      class_name: "fixture.Target",
      method_name: "onCreate",
    });
    if (!outcome.ok) throw outcome.error;
    const result = androidResultSchemas.inspect_android_method.parse(
      outcome.value.normalized_result,
    );
    expect(result.source.status).toBe(
      mode === "truncated" ? "partial" : "complete",
    );
    expect(result.representation).toBe(mode === "smali" ? "smali" : "java");
    if (mode === "truncated")
      expect(result.source.reported_total_bytes).toBe(100);
    else expect(result.fell_back).toBe(true);
    await verifyCleanup(launches);
  },
);

it("cancels active and queued requests, cleans ownership and never launches a queued cancelled request", async () => {
  const { service, apk, launches } = await setup("stall");
  const activeController = new AbortController();
  const active = service.execute(
    "inspect_android_package",
    { path: apk },
    { signal: activeController.signal },
  );
  await expect.poll(() => launches.length).toBe(1);
  const queuedController = new AbortController();
  const queued = service.execute(
    "inspect_android_package",
    { path: apk },
    { signal: queuedController.signal },
  );
  queuedController.abort();
  expect(await queued).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  expect(launches).toHaveLength(1);
  activeController.abort();
  expect(await active).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  await verifyCleanup(launches);
});

it("reports missing explicit tools without trying to install or launch them", async () => {
  const { apk } = await setup();
  const provider = new JadxProvider({}, () => {
    throw new Error("must not launch");
  });
  const outcome = await new AndroidAnalysisService(provider).execute(
    "inspect_android_package",
    { path: apk },
  );
  expect(outcome).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCapabilityUnavailableError",
      reason: expect.stringContaining("REA_JADX_MCP_JAR"),
    },
  });
});

it.each(["tool-error", "frame-overflow"])(
  "preserves the actual failed provider constraint for %s",
  async (mode) => {
    const { service, apk, launches } = await setup(mode);
    const outcome = await service.execute("inspect_android_package", {
      path: apk,
    });
    if (outcome.ok) throw new Error("Expected a provider failure");
    if (mode === "tool-error")
      expect(outcome.error).toMatchObject({
        _tag: "ProviderAdapterError",
        diagnostics: {
          reason: "manifest decoder rejected malformed binary XML",
        },
      });
    else
      expect(outcome.error).toMatchObject({
        _tag: "AnalysisOutputError",
        reason: expect.stringContaining("MCP frame exceeds"),
      });
    await verifyCleanup(launches);
  },
);

it("rejects bytes changed after target admission without launching an engine", async () => {
  const { provider, apk, launches } = await setup();
  const target = await parseBinaryTarget(apk);
  if (!target.ok) throw target.error;
  await writeFile(
    apk,
    Buffer.concat([
      await readFile(apk),
      Buffer.from("changed after admission"),
    ]),
  );
  const outcome = await provider.execute(target.value, {
    operation: "inspect_android_package",
    input: { path: apk },
  });
  expect(outcome).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisInputError",
      issues: [{ message: expect.stringContaining("bytes changed") }],
    },
  });
  expect(launches).toHaveLength(0);
});

it("retains an uncertain workspace and blocks later launches after cleanup cannot be verified", async () => {
  const { service, apk, launches } = await setup("cleanup-failure");
  const outcome = await service.execute("inspect_android_package", {
    path: apk,
  });
  expect(outcome).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  const workspace = launches[0]?.cwd;
  if (workspace === undefined) throw new Error("Expected acquired workspace");
  await expect(access(workspace)).resolves.toBeUndefined();
  expect(
    await service.execute("inspect_android_package", { path: apk }),
  ).toMatchObject({ ok: false, error: { cleanupIncomplete: true } });
  expect(launches).toHaveLength(1);
});

it("does not attribute upstream smali containing all overloads to the selected method", async () => {
  const { service, apk, launches } = await setup("overloaded-smali");
  const outcome = await service.execute("inspect_android_method", {
    path: apk,
    class_name: "fixture.Target",
    method_name: "choose",
    overload_index: 1,
  });
  expect(outcome).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCapabilityUnavailableError",
      reason: expect.stringContaining("joins all same-name overloads"),
    },
  });
  await verifyCleanup(launches);
});

it("reports missing native/abstract method source without claiming an empty implementation", async () => {
  const { service, apk, launches } = await setup("no-body");
  const outcome = await service.execute("inspect_android_method", {
    path: apk,
    class_name: "fixture.Target",
    method_name: "onCreate",
  });
  if (!outcome.ok) throw outcome.error;
  const result = androidResultSchemas.inspect_android_method.parse(
    outcome.value.normalized_result,
  );
  expect(result.body_status).toBe("not_available");
  expect(result.source.text).toContain("no decompiled body");
  await verifyCleanup(launches);
});
