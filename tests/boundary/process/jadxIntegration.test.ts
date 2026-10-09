import { expect, it as test, vi } from "vitest";
import { access, readFile, writeFile } from "node:fs/promises";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { AndroidAnalysisService } from "../../../src/application/android/AndroidAnalysisService.js";
import { JadxProvider } from "../../../src/android/JadxProvider.js";
import { androidResultSchemas } from "../../../src/domain/android/androidAnalysis.js";
import {
  hashAndroidFile,
  snapshotAndroidEngine,
} from "../../../src/android/AndroidTargetSnapshot.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import {
  createJadxProtocolFixture as setup,
  verifyJadxFixtureCleanup as verifyCleanup,
} from "../../fixtures/android/jadx.js";
import { writeJadxJarInventory } from "../../fixtures/android/jadxJar.js";

const it = test.skipIf(process.platform === "win32");

it("rejects a copied JAR that differs from its admitted session identity", async () => {
  const { jar } = await setup();
  const admitted = await hashAndroidFile(jar);
  await writeFile(jar, "engine changed between hashing and copying");
  const root = await PrivateRuntimeRoot.create({
    prefix: "rea-jadx-admission-",
  });
  try {
    await expect(
      snapshotAndroidEngine(
        jar,
        admitted,
        root.path,
        "inspect_android_package",
      ),
    ).rejects.toMatchObject({
      _tag: "AnalysisCapabilityUnavailableError",
      reason: expect.stringContaining("bytes changed"),
    });
  } finally {
    await root.close();
  }
});

it("reuses immutable engine state while keeping each Evidence observation separate", async () => {
  const { service, apk, launches, provider } = await setup();
  const first = await service.execute("inspect_android_package", { path: apk });
  if (!first.ok) throw first.error;
  const preserved = JSON.stringify(first.value);
  const second = await service.execute("inspect_android_class", {
    path: apk,
    class_name: "fixture.Target",
  });
  if (!second.ok) throw second.error;
  expect(launches).toHaveLength(1);
  expect(JSON.stringify(first.value)).toBe(preserved);
  expect(second.value.raw_result).toMatchObject({
    loaded: { class_count: 401 },
    calls: [
      expect.objectContaining({ operation: "rea_jvm_status" }),
      expect.objectContaining({ operation: "get_class_summary" }),
    ],
  });
  expect(
    androidResultSchemas.inspect_android_class.parse(
      second.value.normalized_result,
    ).engine.heap_limit_mib,
  ).toBe(8192);
  await provider.close();
  await verifyCleanup(launches);
});

it("bounds output per operation across a retained session rather than accumulating earlier captures", async () => {
  const { service, apk, launches, provider } = await setup("large-manifest");
  const expectedManifest = "x".repeat(1024 * 1024);
  for (let index = 0; index < 34; index += 1) {
    const result = await service.execute("inspect_android_package", {
      path: apk,
    });
    if (!result.ok) throw result.error;
    expect(
      androidResultSchemas.inspect_android_package.parse(
        result.value.normalized_result,
      ).manifest.text,
    ).toBe(expectedManifest);
  }
  expect(launches).toHaveLength(1);
  await provider.close();
  await verifyCleanup(launches);
});

it("retire sessions when APK bytes, engine bytes or JVM options change", async () => {
  const { service, apk, jar, launches, provider, environment } = await setup();
  const inspect = async () => {
    const result = await service.execute("inspect_android_package", {
      path: apk,
    });
    if (!result.ok) throw result.error;
    return result.value;
  };
  const first = await inspect();
  await writeFile(
    apk,
    Buffer.concat([await readFile(apk), Buffer.from("new artifact bytes")]),
  );
  const changed = await inspect();
  expect(changed.subject?.digest.sha256).not.toBe(first.subject?.digest.sha256);
  await verifyCleanup(launches.slice(0, 1));
  await writeJadxJarInventory(jar, ["fixture/NewEngineMarker.class"]);
  await inspect();
  environment.JAVA_TOOL_OPTIONS = "-Xmx8g";
  environment._JAVA_OPTIONS = "-XX:+UseG1GC";
  await inspect();
  expect(launches).toHaveLength(4);
  expect(launches[3]).toMatchObject({
    javaToolOptions: "-Xmx8g",
    legacyJavaOptions: "-XX:+UseG1GC",
  });
  expect(launches[3]?.arguments).not.toContain("-Xmx512m");
  expect(launches[3]?.arguments).not.toContain("-XX:ActiveProcessorCount=1");
  await provider.close();
  await verifyCleanup(launches);
});

it("retires an idle engine and starts a fresh one for a later request", async () => {
  const { service, apk, launches, provider } = await setup();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const first = await service.execute("inspect_android_package", {
      path: apk,
    });
    if (!first.ok) throw first.error;
    vi.advanceTimersByTime(60_000);
  } finally {
    vi.useRealTimers();
  }
  await expect
    .poll(async () => {
      try {
        await verifyCleanup(launches);
        return true;
      } catch {
        return false;
      }
    })
    .toBe(true);
  const later = await service.execute("inspect_android_package", { path: apk });
  if (!later.ok) throw later.error;
  expect(launches).toHaveLength(2);
  await provider.close();
  await verifyCleanup(launches);
});

it("completes large class inventories with exact case-sensitive search semantics", async () => {
  const { service, apk, provider } = await setup("large-inventory");
  const full = await service.execute("search_android_classes", {
    path: apk,
    query: "",
  });
  if (!full.ok) throw full.error;
  const inventory = androidResultSchemas.search_android_classes.parse(
    full.value.normalized_result,
  );
  expect(inventory.matches).toHaveLength(9001);
  expect(inventory.matches.at(-1)).toBe("fixture.Class8999");
  const mixedCase = await service.execute("search_android_classes", {
    path: apk,
    query: "target",
  });
  if (!mixedCase.ok) throw mixedCase.error;
  expect(
    androidResultSchemas.search_android_classes.parse(
      mixedCase.value.normalized_result,
    ).matches,
  ).toEqual([]);
  await provider.close();
});

it("close cancels active and queued work and prevents later acquisition", async () => {
  const { service, apk, launches, provider } = await setup("stall");
  const active = service.execute("inspect_android_package", { path: apk });
  await expect.poll(() => launches.length).toBe(1);
  const queued = service.execute("inspect_android_package", { path: apk });
  await provider.close();
  for (const result of [
    await active,
    await queued,
    await service.execute("inspect_android_package", { path: apk }),
  ])
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
  expect(launches).toHaveLength(1);
  await verifyCleanup(launches);
});

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
  await healthy.provider.close();
  await verifyCleanup(healthy.launches);
});

it("retains APK identity, original input, raw producer data and normalized observations", async () => {
  const { service, apk, launches, provider } = await setup();
  const outcome = await service.execute("inspect_android_package", {
    path: apk,
  });
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
  await provider.close();
  await verifyCleanup(launches);
});

it("fetches all class pages rather than silently retaining the first upstream page", async () => {
  const { service, apk, launches, provider } = await setup();
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
  await provider.close();
  await verifyCleanup(launches);
});

it("exposes overload candidates and executes only an explicitly selected ambiguous method", async () => {
  const { service, apk, launches, provider } = await setup();
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
      reason: expect.stringContaining("unique method name"),
    },
  });
  await provider.close();
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
    const { service, apk, launches, provider } = await setup(mode);
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
    await provider.close();
    await verifyCleanup(launches);
  },
);

it("rejects fuzzy class resolution and unsupported upstream versions", async () => {
  for (const mode of ["wrong-class", "version", "engine-version"]) {
    const { service, apk, launches, provider } = await setup(mode);
    const outcome = await service.execute("inspect_android_class", {
      path: apk,
      class_name: "fixture.Target",
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: {
        _tag:
          mode === "version" || mode === "engine-version"
            ? "AnalysisCapabilityUnavailableError"
            : "AnalysisInputError",
      },
    });
    await provider.close();
    await verifyCleanup(launches);
  }
});

it.each(["truncated", "smali"])(
  "retains %s source coverage instead of presenting it as successful complete Java",
  async (mode) => {
    const { service, apk, launches, provider } = await setup(mode);
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
    await provider.close();
    await verifyCleanup(launches);
  },
);

it("cancels active and queued requests, cleans ownership and never launches a queued cancelled request", async () => {
  const { service, apk, launches, provider } = await setup("stall");
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
  await provider.close();
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
    const { service, apk, launches, provider } = await setup(mode);
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
    await provider.close();
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
  const { service, apk, launches, provider } = await setup("cleanup-failure");
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
  const { service, apk, launches, provider } = await setup("overloaded-smali");
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
  await provider.close();
  await verifyCleanup(launches);
});

it("reports missing native/abstract method source without claiming an empty implementation", async () => {
  const { service, apk, launches, provider } = await setup("no-body");
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
  await provider.close();
  await verifyCleanup(launches);
});
