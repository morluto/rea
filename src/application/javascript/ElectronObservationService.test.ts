import { expect, it } from "vitest";

import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { parseEvidence } from "../../domain/evidence.js";
import {
  electronPageInspectionSchema,
  electronTargetListSchema,
  inspectElectronPageInputSchema,
} from "../../domain/javascript/electronObservation.js";
import { emptyElectronPageCoverage } from "../../domain/javascript/electronPageInspection.fixture.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { err, ok } from "../../domain/result.js";
import type { ElectronObservationPort } from "./ElectronObservationPort.js";
import {
  inspectElectronPage,
  listElectronTargets,
} from "./ElectronObservationService.js";
import {
  expectDroppedPartial,
  expectKeptPartial,
  expectOwnerError,
} from "../../../tests/fixtures/ownerObservationExpectation.js";

const identity = { id: "electron-fixture", name: "Fixture", version: "1" };
const pageProvider = (failure: AnalysisError): ElectronObservationPort => ({
  identity: () => identity,
  listTargets: async () =>
    err(new AnalysisCancelledError("list_electron_targets")),
  inspectPage: async () => err(failure),
});
const input = inspectElectronPageInputSchema.parse({
  cdp_endpoint: "http://127.0.0.1:9222",
  target_id: "electron-page",
  observation_ms: 0,
});
const inspection = electronPageInspectionSchema.parse({
  browser: {
    product: "Electron",
    protocol_version: "1.3",
    revision: "fixture",
    user_agent: "Electron fixture",
    js_version: "V8 fixture",
  },
  target: {
    target_id: "electron-page",
    type: "page",
    title: "Fixture",
    file_path: "/app/index.html",
    attached: false,
  },
  ...emptyElectronPageCoverage(),
});

it("converts a retained raw Electron inspection into partial Evidence", async () => {
  const failure = new AnalysisCancelledError("inspect_electron_page", {
    partialObservation: {
      kind: "electron-page-observation",
      inspection,
      cleanup: "transport-closed",
    },
  });
  const result = await inspectElectronPage(pageProvider(failure), input);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBe(failure);
    expect(parseEvidence(result.error.partialObservation)).toMatchObject({
      operation: "inspect_electron_page",
      normalized_result: {
        ...inspection,
        limitations: [
          "REA closed its CDP transport; this does not imply target shutdown.",
        ],
      },
      limitations: expect.arrayContaining([
        "REA closed its CDP transport; this does not imply target shutdown.",
      ]),
    });
  }
});

it("converts a raw inspection retained by provider cleanup failure", async () => {
  const failure = new ProviderCleanupError(
    "rea-cdp-electron",
    ["electron-page"],
    { reason: "target detach failed" },
    {
      operation: "inspect_electron_page",
      partialObservation: {
        kind: "electron-page-observation",
        inspection,
        cleanup: "incomplete",
      },
    },
  );
  const result = await inspectElectronPage(pageProvider(failure), input);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBe(failure);
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(parseEvidence(result.error.partialObservation)).toMatchObject({
      operation: "inspect_electron_page",
      normalized_result: {
        ...inspection,
        limitations: ["CDP transport cleanup remains incomplete."],
      },
      limitations: expect.arrayContaining([
        "CDP transport cleanup remains incomplete.",
      ]),
    });
  }
});

it("returns a typed output error for malformed Electron target output after abort", async () => {
  const controller = new AbortController();
  const malformed = {
    browser: {
      product: "Electron",
      protocol_version: "1.3",
      revision: "fixture",
      user_agent: "Electron fixture",
      js_version: "V8 fixture",
    },
    targets: [],
    excluded: { unsupported_url: 0, non_page: 0 },
    limitations: [() => undefined],
  } as unknown as ReturnType<typeof electronTargetListSchema.parse>;
  const provider: ElectronObservationPort = {
    identity: () => identity,
    listTargets: async () => {
      controller.abort();
      return { ok: true, value: malformed };
    },
    inspectPage: async () =>
      err(new AnalysisCancelledError("inspect_electron_page")),
  };
  const result = await listElectronTargets(
    provider,
    {
      cdp_endpoint: "http://127.0.0.1:9222",
    },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});

it("retains completed target facts when cancellation arrives before Evidence publication", async () => {
  const controller = new AbortController();
  const reason = { requested: "stop after listing targets" };
  const targets = electronTargetListSchema.parse({
    browser: inspection.browser,
    targets: [],
    excluded: { unsupported_url: 0, non_page: 0 },
    limitations: [],
  });
  const provider: ElectronObservationPort = {
    identity: () => identity,
    listTargets: async () => {
      controller.abort(reason);
      return ok(targets);
    },
    inspectPage: async () =>
      err(new AnalysisCancelledError("inspect_electron_page")),
  };
  const result = await listElectronTargets(
    provider,
    { cdp_endpoint: input.cdp_endpoint },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(reason);
    expect(parseEvidence(result.error.partialObservation)).toMatchObject({
      operation: "list_electron_targets",
      provider: identity,
      parameters: { cdp_endpoint: input.cdp_endpoint },
      confidence: "observed",
      authority: "external-service",
      environment: {
        id: `${inspection.browser.product}@${inspection.browser.revision}`,
        platform: "unknown",
        architecture: "unknown",
        isolation: "none",
      },
      limitations: expect.arrayContaining([
        expect.stringMatching(/platform.*architecture.*not observed/iu),
      ]),
      normalized_result: targets,
    });
  }
});

it.each(["list", "inspect"] as const)(
  "preserves a pre-abort reason before Electron %s provider work",
  async (kind) => {
    const reason = new Error(`stop Electron ${kind}`);
    const controller = new AbortController();
    controller.abort(reason);
    let providerCalls = 0;
    const provider: ElectronObservationPort = {
      identity: () => identity,
      listTargets: async () => {
        providerCalls += 1;
        return err(new AnalysisCancelledError("list_electron_targets"));
      },
      inspectPage: async () => {
        providerCalls += 1;
        return err(new AnalysisCancelledError("inspect_electron_page"));
      },
    };

    const result =
      kind === "list"
        ? await listElectronTargets(
            provider,
            { cdp_endpoint: input.cdp_endpoint },
            { signal: controller.signal },
          )
        : await inspectElectronPage(provider, input, {
            signal: controller.signal,
          });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AnalysisCancelledError);
      expect(result.error.cause).toBe(reason);
    }
    expect(providerCalls).toBe(0);
  },
);

it("keeps cancellation when the retained Electron inspection is incomplete", async () => {
  const reason = { requested: "stop before page inspection completed" };
  // A JSON-safe but incomplete inspection cannot be converted into Evidence.
  const partial = {
    kind: "electron-page-observation",
    inspection: { target_id: "electron-page" },
    cleanup: "incomplete",
  };
  const failure = new AnalysisCancelledError("inspect_electron_page", {
    cause: reason,
    partialObservation: partial as never,
  });
  const result = await inspectElectronPage(pageProvider(failure), input);
  expectKeptPartial(expectOwnerError(result, failure, reason), partial);
});

it.each([
  { inspection: { requests: Number.NaN }, cleanup: "incomplete" as const },
  {
    inspection: { scripts: [undefined] },
    cleanup: "transport-closed" as const,
  },
])(
  "drops a non-JSON Electron inspection and keeps cancellation primary",
  async (unsafe) => {
    const reason = { requested: "stop before page inspection completed" };
    const failure = new AnalysisCancelledError("inspect_electron_page", {
      cause: reason,
      partialObservation: {
        kind: "electron-page-observation",
        ...unsafe,
      } as never,
    });
    const result = await inspectElectronPage(pageProvider(failure), input);
    expectDroppedPartial(
      expectOwnerError(result, failure, reason),
      "Electron provider retained a non-JSON incomplete observation.",
    );
  },
);

it.each([
  { ...inspection, target: { ...inspection.target, target_id: "other-page" } },
  {
    ...inspection,
    capture_window: { ...inspection.capture_window, observation_ms: 1 },
  },
])(
  "refuses to attest a different selected page or capture window",
  async (report) => {
    const provider = pageProvider(
      new AnalysisCancelledError("inspect_electron_page"),
    );
    const result = await inspectElectronPage(
      { ...provider, inspectPage: async () => ok(report) },
      input,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisOutputError", partialObservation: report },
    });
    const failure = new AnalysisCancelledError("inspect_electron_page", {
      partialObservation: {
        kind: "electron-page-observation",
        inspection: report,
        cleanup: "transport-closed",
      },
    });
    const partial = failure.partialObservation;
    const cancelled = await inspectElectronPage(pageProvider(failure), input);
    expect(cancelled).toMatchObject({ ok: false, error: failure });
    expect(failure.partialObservation).toEqual(partial);
    expect(failure.secondaryFailures).toMatchObject([
      { _tag: "AnalysisOutputError" },
    ]);
  },
);

it.each(["completed", "partial"] as const)(
  "does not invoke hidden provider getters in a %s page report",
  async (phase) => {
    const report = { ...inspection };
    let getterCalls = 0;
    Object.defineProperty(report, "target", {
      enumerable: false,
      get() {
        getterCalls += 1;
        throw new Error("Hidden target getter must not run");
      },
    });
    const failure = new AnalysisCancelledError("inspect_electron_page", {
      partialObservation: {
        kind: "electron-page-observation",
        inspection: report,
        cleanup: "transport-closed",
      },
    });
    const provider = pageProvider(failure);
    const result = inspectElectronPage(
      phase === "partial"
        ? provider
        : { ...provider, inspectPage: async () => ok(report) },
      input,
    );
    await expect(result).resolves.toMatchObject({
      ok: false,
      error:
        phase === "partial"
          ? { _tag: "AnalysisCancelledError" }
          : { _tag: "AnalysisOutputError" },
    });
    expect(getterCalls).toBe(0);
  },
);

it.each(["extension", "omission"])(
  "retains passive Electron source %s before named contract normalization",
  async (kind) => {
    const { workers: _workers, ...withoutWorkers } = inspection;
    const source =
      kind === "extension"
        ? { ...inspection, provider_metadata: { source_id: "own-source" } }
        : withoutWorkers;
    const provider: ElectronObservationPort = {
      identity: () => identity,
      listTargets: async () =>
        err(new AnalysisCancelledError("list_electron_targets")),
      inspectPage: async () => ok(source as typeof inspection),
    };
    const result = await inspectElectronPage(provider, input);
    if (!result.ok) throw result.error;
    expect(result.value.raw_result).toEqual(source);
    expect(result.value.normalized_result).toHaveProperty("workers", []);
    expect(result.value.normalized_result).not.toHaveProperty(
      "provider_metadata",
    );
  },
);

it("retains passive source metadata when promoting a completed failure inspection", async () => {
  const source = {
    ...inspection,
    provider_metadata: { source_id: "partial-source" },
  };
  const failure = new AnalysisCancelledError("inspect_electron_page", {
    partialObservation: {
      kind: "electron-page-observation",
      inspection: source,
      cleanup: "transport-closed",
    },
  });
  const result = await inspectElectronPage(pageProvider(failure), input);
  if (result.ok) throw new Error("expected retained failure");
  expect(parseEvidence(result.error.partialObservation).raw_result).toEqual(
    source,
  );
});

it("does not duplicate unchanged passive Electron source JSON", async () => {
  const result = await inspectElectronPage(
    {
      ...pageProvider(new AnalysisCancelledError("inspect_electron_page")),
      inspectPage: async () => ok(inspection),
    },
    input,
  );
  if (!result.ok) throw result.error;
  expect(result.value.raw_result).toBeNull();
});
