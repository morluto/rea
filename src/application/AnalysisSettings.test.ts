import { expect, it } from "vitest";
import { AnalysisSettings } from "./AnalysisSettings.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  applyWindowsChangeTimeSnapshot,
  resolveWindowsChangeTimeSettle,
} from "../config/windowsChangeTimeSettle.js";
import { pwntoolsInputBytes } from "../native/pwntools/PwntoolsInputLimit.js";
import { resolveBridgeMaxRequestBytes } from "../config/bridgeMaxRequestBytes.js";
import { resolveCaptureDecoderHeap } from "../config/captureDecoderHeap.js";
import { resolveRegexMatchingDeadline } from "../config/regexMatchingDeadline.js";
import { resolveRegexWorkerHeapRequest } from "../config/regexWorkerHeapRequest.js";
import { runWithAnalysisOperationSnapshot } from "../domain/analysisOperationSnapshot.js";
import {
  runtimeAnalysisConfig,
  runtimeAsarHeaderAdmission,
  runtimeCaptureDecoderHeap,
} from "../config/runtimeAnalysisSettings.js";
import { parseConfig } from "../config/parseConfig.js";

it.each(["search_strings", "search_procedures"])(
  "exposes shared regex controls when filtering for Binary Ninja %s",
  (operation) => {
    const store = new AnalysisSettings({
      REA_REGEX_MATCHING_DEADLINE_MS: "9000",
      REA_REGEX_WORKER_HEAP_REQUEST_MIB: "80",
    });
    expect(
      store.inspect({ provider: "binary-ninja", operation }).settings,
    ).toMatchObject([
      { setting: "regex.matching_deadline_ms", value: 9000 },
      { setting: "regex.worker_heap_request_mib", value: 80 },
    ]);
  },
);

it.each([
  ["inspect_native_api", [64, 7]],
  ["trace_native_ui_action", []],
] as const)(
  "reports the decompiler budgets consumed by %s",
  (operation, values) => {
    const store = new AnalysisSettings({
      REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS: "7",
      REA_GHIDRA_DECOMPILE_MAX_PAYLOAD_MIB: "64",
    });
    expect(
      store
        .inspect({
          provider: "ghidra",
          operation,
          settings: [
            "ghidra.decompile_max_payload_mib",
            "ghidra.decompile_timeout_seconds",
          ],
        })
        .settings.map(({ value }) => value),
    ).toEqual(values);
  },
);

it("updates atomically, restores launch values, and refuses stale or invalid writes", () => {
  const store = new AnalysisSettings({ REA_ASAR_MAX_HEADER_BYTES: "20000000" });
  const inspect = () => store.inspect({ settings: ["asar.max_header_bytes"] });
  expect(inspect().settings[0]).toMatchObject({
    value: 20000000,
    source: "setting",
  });
  expect(
    store.update({
      changes: [
        { setting: "asar.max_header_bytes", action: "set", value: 30000000 },
      ],
      expected_revision: 0,
    }).ok,
  ).toBe(true);
  expect(inspect()).toMatchObject({
    revision: 1,
    settings: [{ value: 30000000, source: "runtime" }],
  });
  expect(
    store.update({
      changes: [
        { setting: "asar.max_header_bytes", action: "set", value: 30000000 },
      ],
    }),
  ).toMatchObject({ ok: true, value: { changed: false, revision: 1 } });
  for (const changes of [
    [
      { setting: "asar.max_header_bytes", action: "set", value: 100 },
      { setting: "wasm.command_timeout_ms", action: "set", value: 0 },
    ],
    [
      { setting: "asar.max_header_bytes", action: "reset" },
      { setting: "asar.max_header_bytes", action: "set", value: 100 },
    ],
    [{ setting: "NODE_OPTIONS", action: "set", value: 1 }],
  ])
    expect(store.update({ changes }).ok).toBe(false);
  expect(
    store.update({
      changes: [{ setting: "asar.max_header_bytes", action: "reset" }],
      expected_revision: 0,
    }).ok,
  ).toBe(false);
  expect(inspect().revision).toBe(1);
  expect(
    store.update({
      changes: [{ setting: "asar.max_header_bytes", action: "reset" }],
    }),
  ).toMatchObject({
    ok: true,
    value: { revision: 2, settings: [{ value: 20000000, source: "setting" }] },
  });
  expect(new AnalysisSettings({}).inspect().revision).toBe(0);
});

it("keeps accepted operations and their typed provider views stable across concurrent updates", async () => {
  const store = new AnalysisSettings({});
  const config = parseConfig({});
  if (!config.ok) throw config.error;
  const live = runtimeAnalysisConfig(config.value, store.read);
  const asar = runtimeAsarHeaderAdmission({}, store.read);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = store.run(async () => {
    await barrier;
    expect(asar.maximumBytes).toBe(16777216);
    expect(asar.listing?.maximumBytes).toBe(67108864);
    expect(live.ghidraValueFlowMaxOperations).toBe(3000);
    expect(live.ghidraValueFlowMaxInputsPerOperation).toBe(64);
    expect(live.ghidraValueFlowMaxEdges).toBe(12000);
    expect(live.ghidraStartupTimeoutMs).toBe(330000);
    expect(live.regexMatchingDeadline.deadlineMs).toBe(5000);
    expect(store.read().revision).toBe(0);
  });
  try {
    const changed = store.update({
      changes: [
        { setting: "asar.max_header_bytes", action: "set", value: 33554432 },
        { setting: "asar.max_listing_bytes", action: "set", value: 134217728 },
        {
          setting: "ghidra.value_flow_max_operations",
          action: "set",
          value: 6000,
        },
        {
          setting: "ghidra.value_flow_max_inputs_per_operation",
          action: "set",
          value: 128,
        },
        { setting: "ghidra.value_flow_max_edges", action: "set", value: 24000 },
        { setting: "ghidra.startup_timeout_ms", action: "set", value: 999999 },
        { setting: "regex.matching_deadline_ms", action: "set", value: 10000 },
      ],
    });
    expect(changed.ok).toBe(true);
  } finally {
    release();
    await Promise.allSettled([pending]);
  }
  await pending;
  store.run(() => {
    expect(asar.maximumBytes).toBe(33554432);
    expect(asar.listing?.maximumBytes).toBe(134217728);
    expect(live.ghidraValueFlowMaxOperations).toBe(6000);
    expect(live.ghidraValueFlowMaxInputsPerOperation).toBe(128);
    expect(live.ghidraValueFlowMaxEdges).toBe(24000);
    expect(live.ghidraStartupTimeoutMs).toBe(999999);
    expect(live.regexMatchingDeadline.deadlineMs).toBe(10000);
  });
});

it("exposes shared provider controls and preserves the explicit unbounded decompile value", () => {
  const environment = {
    REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS: "7",
    REA_GHIDRA_DECOMPILE_MAX_PAYLOAD_MIB: "64",
  };
  const store = new AnalysisSettings(environment);
  for (const provider of ["ghidra", "hopper"] as const)
    expect(
      store
        .inspect({ provider, operation: "open_binary" })
        .settings.map(({ setting }) => setting),
    ).toEqual(
      expect.arrayContaining([
        `${provider}.startup_timeout_ms`,
        "bridge.max_request_bytes",
      ]),
    );
  const parsed = parseConfig(environment);
  if (!parsed.ok) throw parsed.error;
  const config = runtimeAnalysisConfig(parsed.value, store.read);
  expect(config.ghidraDecompileMaxPayloadMiB).toBe(64);
  expect(
    store
      .inspect({ provider: "ghidra", operation: "search_strings" })
      .settings.map(({ setting }) => setting),
  ).toEqual(["ghidra.startup_timeout_ms", "bridge.max_request_bytes"]);
  for (const operation of ["list_cutter_sessions", "cutter_command"] as const)
    expect(
      store
        .inspect({ provider: "cutter", operation })
        .settings.map(({ setting }) => setting),
    ).toContain("bridge.max_request_bytes");
  expect(
    store
      .inspect({ provider: "ida", operation: "search_strings" })
      .settings.map(({ setting }) => setting),
  ).toEqual(["regex.matching_deadline_ms", "regex.worker_heap_request_mib"]);
  expect(
    store
      .inspect({ operation: "inventory_artifact" })
      .settings.map(({ setting }) => setting),
  ).toEqual([
    "asar.max_listing_bytes",
    "asar.max_header_bytes",
    "windows.change_time_drift_ms",
    "windows.change_time_settle_poll_ms",
    "windows.change_time_settle_max_polls",
  ]);
  for (const operation of [
    "open_binary",
    "export_web_scripts",
    "inspect_analysis_view",
    "inspect_android_package",
    "capture_process_scenario",
  ]) {
    expect(
      store.inspect({ operation }).settings.map(({ setting }) => setting),
    ).toEqual(
      expect.arrayContaining([
        "windows.change_time_drift_ms",
        "windows.change_time_settle_poll_ms",
        "windows.change_time_settle_max_polls",
      ]),
    );
  }
  expect(
    store
      .inspect({ provider: "jadx", operation: "inspect_android_package" })
      .settings.map(({ setting }) => setting),
  ).toEqual(
    expect.arrayContaining([
      "windows.change_time_drift_ms",
      "windows.change_time_settle_poll_ms",
      "windows.change_time_settle_max_polls",
    ]),
  );
  for (const operation of [
    "procedure_pseudo_code",
    "procedure_assembly",
    "analyze_function",
  ] as const)
    expect(
      store
        .inspect({ provider: "kuna", operation })
        .settings.map(({ setting }) => setting),
    ).toContain("kuna.project_timeout_ms");
  expect(
    store.update({
      changes: [
        {
          setting: "ghidra.decompile_timeout_seconds",
          action: "set",
          value: null,
        },
        {
          setting: "ghidra.decompile_max_payload_mib",
          action: "set",
          value: null,
        },
      ],
    }).ok,
  ).toBe(true);
  expect(config.ghidraDecompileTimeoutSeconds).toBeUndefined();
  expect(config.ghidraDecompileMaxPayloadMiB).toBeUndefined();
  expect(
    store.inspect({ settings: ["ghidra.decompile_timeout_seconds"] })
      .settings[0],
  ).toMatchObject({ value: null, launch_value: 7, source: "runtime" });
  for (const [setting, value] of [
    ["asar.max_header_bytes", null],
    ["asar.max_listing_bytes", 0],
    ["asar.max_listing_bytes", Number.MAX_SAFE_INTEGER + 1],
    ["ghidra.value_flow_max_operations", 0],
    ["ghidra.value_flow_max_inputs_per_operation", 2147483648],
    ["ghidra.decompile_max_payload_mib", 2048],
    ["asar.max_header_bytes", 268435457],
    ["javascript.max_heap_mb", 127],
    ["regex.matching_deadline_ms", 1.5],
  ]) {
    expect(
      store.update({ changes: [{ setting, action: "set", value }] }).ok,
    ).toBe(false);
  }
  expect(store.inspect().revision).toBe(1);
  expect(
    store.update({
      changes: [
        { setting: "ghidra.decompile_timeout_seconds", action: "reset" },
      ],
    }).ok,
  ).toBe(true);
  expect(config.ghidraDecompileTimeoutSeconds).toBe(7);
});

it("rejects an out-of-range per-call limit and reads an accepted value from the operation snapshot", () => {
  const store = new AnalysisSettings({});
  const rejected = store.update({
    changes: [
      { setting: "windows.change_time_drift_ms", action: "set", value: 0 },
    ],
  });
  expect(rejected.ok).toBe(false);
  if (!rejected.ok)
    expect(projectAnalysisError(rejected.error)).toMatchObject({
      code: "invalid_request",
    });
  expect(
    store.update({
      changes: [
        { setting: "bridge.max_request_bytes", action: "set", value: 1 },
      ],
    }).ok,
  ).toBe(false);
  expect(
    store.update({
      changes: [
        {
          setting: "windows.change_time_settle_max_polls",
          action: "set",
          value: 1001,
        },
      ],
    }).ok,
  ).toBe(false);
  const accepted = store.update({
    changes: [
      { setting: "windows.change_time_drift_ms", action: "set", value: 5000 },
      { setting: "pwntools.max_input_bytes", action: "set", value: 65536 },
      { setting: "bridge.max_request_bytes", action: "set", value: 33554432 },
    ],
  });
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;
  expect(accepted.value).toMatchObject({
    pending_restart: false,
  });
  const parsed = parseConfig({});
  if (!parsed.ok) throw parsed.error;
  const live = runtimeAnalysisConfig(parsed.value, store.read);
  store.run(() => {
    const windows = resolveWindowsChangeTimeSettle({});
    if (!windows.ok) throw windows.error;
    expect(applyWindowsChangeTimeSnapshot(windows.value)).toMatchObject({
      driftMs: 5000,
      driftSource: "runtime",
      pollSource: "default",
    });
    expect(pwntoolsInputBytes({})).toMatchObject({
      configured: true,
      bytes: 65536,
      source: "runtime",
    });
    expect(live.bridgeMaxRequestBytes).toMatchObject({
      maximumBytes: 33554432,
      source: "runtime",
    });
    expect(live.hopperStartupTimeoutSource).toBe("default");
  });
  expect(pwntoolsInputBytes({})).toMatchObject({
    bytes: 32 * 1024 * 1024,
    source: "default",
  });
});

it("reads an accepted override before an invalid launch seed", () => {
  const resolved = runWithAnalysisOperationSnapshot(
    {
      revision: 1,
      overrides: {
        "bridge.max_request_bytes": 8192,
        "capture.decoder_old_generation_mib": 64,
        "regex.matching_deadline_ms": 250,
        "regex.worker_heap_request_mib": 128,
        "asar.max_header_bytes": 8192,
        "asar.max_listing_bytes": 4096,
      },
    },
    () => ({
      bridge: resolveBridgeMaxRequestBytes({
        REA_BRIDGE_MAX_REQUEST_BYTES: "nope",
      }),
      capture: resolveCaptureDecoderHeap({
        REA_CAPTURE_DECODER_OLD_GENERATION_MIB: "0",
      }),
      deadline: resolveRegexMatchingDeadline({
        REA_REGEX_MATCHING_DEADLINE_MS: "nope",
      }),
      heap: resolveRegexWorkerHeapRequest({
        REA_REGEX_WORKER_HEAP_REQUEST_MIB: "1",
      }),
      asar: runtimeAsarHeaderAdmission({
        REA_ASAR_MAX_HEADER_BYTES: "nope",
        REA_ASAR_MAX_LISTING_BYTES: "0",
      }),
    }),
  );
  expect(resolved.bridge).toMatchObject({
    maximumBytes: 8192,
    source: "runtime",
  });
  expect(resolved.capture).toMatchObject({
    oldGenerationMiB: 64,
    source: "runtime",
  });
  expect(resolved.deadline).toMatchObject({
    deadlineMs: 250,
    source: "runtime",
  });
  expect(resolved.heap).toMatchObject({ heapMiB: 128, source: "runtime" });
  expect(resolved.asar).toMatchObject({
    maximumBytes: 8192,
    source: "runtime",
    listing: { maximumBytes: 4096, source: "runtime" },
  });
});

it("keeps the Hopper startup deadline source through a runtime override", () => {
  const parsed = parseConfig({ REA_HOPPER_STARTUP_TIMEOUT_MS: "45000" });
  if (!parsed.ok) throw parsed.error;
  const store = new AnalysisSettings({});
  const live = runtimeAnalysisConfig(parsed.value, store.read);
  expect(live.hopperStartupTimeoutSource).toBe("setting");
  expect(
    store.update({
      changes: [
        { setting: "hopper.startup_timeout_ms", action: "set", value: 8000 },
      ],
    }).ok,
  ).toBe(true);
  store.run(() => {
    expect(live.hopperStartupTimeoutMs).toBe(8000);
    expect(live.hopperStartupTimeoutSource).toBe("runtime");
  });
});

it("retains invalid ASAR seeds across long-lived views and override resets", async () => {
  const environment = {
    REA_ASAR_MAX_HEADER_BYTES: "invalid",
    REA_ASAR_MAX_LISTING_BYTES: "invalid",
  };
  const store = new AnalysisSettings(environment);
  const admission = runtimeAsarHeaderAdmission(environment, store.read);
  expect(() => admission.maximumBytes).toThrow("REA_ASAR_MAX_HEADER_BYTES");
  expect(() => admission.listing?.source).toThrow("REA_ASAR_MAX_LISTING_BYTES");
  store.update({
    changes: [
      { setting: "asar.max_header_bytes", action: "set", value: 8192 },
      { setting: "asar.max_listing_bytes", action: "set", value: 4096 },
    ],
  });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const accepted = store.run(async () => {
    await barrier;
    expect(admission).toMatchObject({
      maximumBytes: 8192,
      source: "runtime",
      listing: { maximumBytes: 4096, source: "runtime" },
    });
  });
  store.update({
    changes: [
      { setting: "asar.max_header_bytes", action: "reset" },
      { setting: "asar.max_listing_bytes", action: "reset" },
    ],
  });
  release();
  await accepted;
  for (const read of [() => admission.maximumBytes, () => admission.source])
    expect(read).toThrow("REA_ASAR_MAX_HEADER_BYTES");
  for (const read of [
    () => admission.listing?.maximumBytes,
    () => admission.listing?.source,
  ])
    expect(read).toThrow("REA_ASAR_MAX_LISTING_BYTES");
});

it("retains an invalid capture heap seed through override and reset", () => {
  const environment = { REA_CAPTURE_DECODER_OLD_GENERATION_MIB: "invalid" };
  const store = new AnalysisSettings(environment);
  const heap = runtimeCaptureDecoderHeap(environment, store.read);
  expect(() => heap.oldGenerationMiB).toThrow(
    "REA_CAPTURE_DECODER_OLD_GENERATION_MIB",
  );
  store.update({
    changes: [
      {
        setting: "capture.decoder_old_generation_mib",
        action: "set",
        value: 64,
      },
    ],
  });
  expect(heap).toMatchObject({ oldGenerationMiB: 64, source: "runtime" });
  store.update({
    changes: [
      { setting: "capture.decoder_old_generation_mib", action: "reset" },
    ],
  });
  expect(() => heap.oldGenerationMiB).toThrow(
    "REA_CAPTURE_DECODER_OLD_GENERATION_MIB",
  );
  expect(() => heap.source).toThrow("REA_CAPTURE_DECODER_OLD_GENERATION_MIB");
});
