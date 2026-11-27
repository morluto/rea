import type { AnalysisSettingsReader } from "../domain/analysisSettings.js";
import type { ElectronObservationPort } from "../ports/javascript/ElectronObservationPort.js";
import type { ElectronActiveObservationPort } from "../ports/javascript/ElectronActiveObservationPort.js";
import {
  inspectElectronPage,
  listElectronTargets,
} from "../application/javascript/ElectronObservationService.js";
import { captureElectronScenario } from "../application/javascript/ElectronActiveObservationService.js";
import { analyzeJavaScriptApplicationValidated } from "../application/javascript/JavaScriptApplicationService.js";
import { reconcileJavaScriptRuntimeEvidence } from "../application/javascript/JavaScriptRuntimeReconciliationService.js";
import { javascriptSourceAnalysis } from "../composition/javascriptSourceAnalysis.js";
import {
  projectRetainedAnalysis,
  summarizeRetainedAnalysis,
} from "../application/analysisView/AnalysisViewService.js";
import {
  requireAnalysisViewRetention,
  type AnalysisViewRetention,
} from "../application/analysisView/AnalysisViewRetention.js";
import { recordEvidenceSources } from "../application/investigation/recordEvidenceSources.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { err, ok } from "../domain/result.js";
import type { BrowserObservationPort } from "../ports/BrowserObservationPort.js";
import {
  optionalProviderUnavailable,
  type OptionalProviderLoadFailure,
} from "../ports/OptionalObservationProviders.js";
import { browserScenarioSchema } from "../domain/browserScenario.js";
import type { BrowserScenarioCapturePort } from "../ports/BrowserScenarioCapturePort.js";
import { captureBrowserScenario } from "../application/BrowserScenarioCaptureService.js";
import type { JavaScriptRuntimeObservationPort } from "../ports/javascript/JavaScriptRuntimeObservationPort.js";
import {
  listJavaScriptRuntimeTargets,
  observeJavaScriptRuntime,
} from "../application/javascript/JavaScriptRuntimeObservationService.js";
import {
  analyzeWebBundle,
  captureWebScreenshot,
  compareWebCaptureEvidence,
  compareWebScreenshotEvidence,
  discoverWebMcpTools,
  inspectWebPage,
  listBrowserTargets,
  observeWebSession,
} from "../application/BrowserObservationService.js";
import type { ArtifactResourceScope } from "../resources/index.js";
import type { ContractToolBindings } from "./contractToolBindings.js";

/** The browser observation provider, or why it failed to load. */
export interface BrowserObservationToolOptions {
  readonly browser: BrowserObservationPort | undefined;
  readonly loadFailure?: OptionalProviderLoadFailure | undefined;
}

/** Passive Electron observation is independent of active scenario capture. */
export interface ElectronObservationToolOptions {
  readonly provider: ElectronObservationPort | undefined;
  readonly loadFailure?: OptionalProviderLoadFailure | undefined;
}

/** Existing owned Electron scenario execution and its independent load failure. */
export interface ElectronScenarioToolOptions {
  readonly provider: ElectronActiveObservationPort | undefined;
  readonly loadFailure?: OptionalProviderLoadFailure | undefined;
}

/** Static JavaScript analysis needs local artifacts, never an Electron runtime. */
export interface JavaScriptApplicationToolOptions {
  readonly resources: ArtifactResourceScope;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly settings?: AnalysisSettingsReader;
}

/** The browser scenario provider, or why it failed to load. */
export interface BrowserScenarioToolOptions {
  readonly provider: BrowserScenarioCapturePort | undefined;
  readonly loadFailure?: OptionalProviderLoadFailure | undefined;
}

/** The JavaScript runtime observation provider, or why it failed to load. */
export interface JavaScriptRuntimeToolOptions {
  readonly runtime: JavaScriptRuntimeObservationPort | undefined;
  readonly loadFailure?: OptionalProviderLoadFailure | undefined;
}

/** Browser observation runs through an optional provider; when it failed to load, every call reports it unavailable before admission. */
export const bindBrowserObservationTools = (
  { browser, loadFailure }: BrowserObservationToolOptions,
  retention: AnalysisViewRetention,
): ContractToolBindings => {
  const optional = { unavailable: loadFailure };
  return {
    list_browser_targets: {
      admission: "sdk",
      ...optional,
      run: (input, options) => listBrowserTargets(browser, input, options),
    },
    inspect_web_page: {
      admission: "sdk",
      ...optional,
      // Delivery detail never reaches the capture, so its Evidence identity
      // is the same for every detail.
      run: async ({ detail, ...request }, options) => {
        if (detail === "summary") {
          const ready = requireAnalysisViewRetention(
            "inspect_web_page",
            retention,
          );
          if (!ready.ok) return ready;
        }
        const inspected = await inspectWebPage(browser, request, options);
        return inspected.ok && detail === "summary"
          ? summarizeRetainedAnalysis(inspected.value, retention)
          : inspected;
      },
    },
    analyze_web_bundle: {
      admission: "sdk",
      ...optional,
      run: async ({ detail, view, ...request }, options) => {
        if (detail === "summary") {
          const ready = requireAnalysisViewRetention(
            "analyze_web_bundle",
            retention,
          );
          if (!ready.ok) return ready;
        }
        const analyzed = await analyzeWebBundle(browser, request, options);
        return analyzed.ok && detail === "summary"
          ? projectRetainedAnalysis(
              analyzed.value,
              retention,
              view ?? { kind: "summary" },
            )
          : analyzed;
      },
    },
    observe_web_session: {
      admission: "sdk",
      ...optional,
      run: (input, options) => observeWebSession(browser, input, options),
    },
    discover_webmcp_tools: {
      admission: "sdk",
      ...optional,
      run: (input, options) => discoverWebMcpTools(browser, input, options),
    },
    compare_web_captures: {
      // The comparison admits the raw request once: inline captures parse as
      // the comparison input, and retained references resolve first.
      admission: "application",
      ...optional,
      run: (input) =>
        compareWebCaptureEvidence(browser, input, retention.evidenceById),
    },
    capture_web_screenshot: {
      admission: "sdk",
      ...optional,
      run: (input, options) => captureWebScreenshot(browser, input, options),
    },
    compare_web_screenshots: {
      admission: "sdk",
      ...optional,
      run: (input) => compareWebScreenshotEvidence(browser, input),
    },
  };
};

/** Passive Electron observation tools. */
export const bindElectronObservationTools = ({
  provider,
  loadFailure,
}: ElectronObservationToolOptions): ContractToolBindings => ({
  list_electron_targets: {
    admission: "sdk",
    unavailable: loadFailure,
    run: (input, options) => listElectronTargets(provider, input, options),
  },
  inspect_electron_page: {
    admission: "sdk",
    unavailable: loadFailure,
    run: (input, options) => inspectElectronPage(provider, input, options),
  },
});

/** Active Electron scenario capture tool. */
export const bindElectronScenarioTools = ({
  provider,
  loadFailure,
}: ElectronScenarioToolOptions): ContractToolBindings => ({
  capture_electron_scenario: {
    admission: "sdk",
    unavailable: loadFailure,
    run: (input, options) => captureElectronScenario(provider, input, options),
  },
});

/** Static JavaScript application analysis and runtime reconciliation tools. */
export const bindJavaScriptApplicationTools = (
  { resources, environment, settings }: JavaScriptApplicationToolOptions,
  retention: AnalysisViewRetention,
): ContractToolBindings => ({
  analyze_javascript_application: {
    admission: "sdk",
    run: async ({ detail, view, ...request }, options) => {
      if (detail === "summary") {
        const ready = requireAnalysisViewRetention(
          "analyze_javascript_application",
          retention,
        );
        if (!ready.ok) return ready;
      }
      const analyzed = await analyzeJavaScriptApplicationValidated(
        request,
        resources,
        {
          ...options,
          sourceAnalysis: javascriptSourceAnalysis,
          environment,
          ...(settings === undefined ? {} : { settings }),
        },
      );
      return detail === "summary" && analyzed.ok
        ? projectRetainedAnalysis(
            analyzed.value,
            retention,
            view ?? { kind: "summary" },
          )
        : analyzed;
    },
  },
  reconcile_javascript_runtime: {
    admission: "sdk",
    run: async (input, options) => {
      const result = reconcileJavaScriptRuntimeEvidence(
        input,
        retention.evidenceById,
        options,
      );
      if (!result.ok) return result;
      const recorded = recordEvidenceSources(
        retention.recordEvidence,
        result.value.sources,
        { evidence: result.value.evidence },
      );
      return recorded.ok ? ok(result.value.evidence) : recorded;
    },
  },
});

/** Browser scenario capture tool with schema field-path diagnostics before provider checks. */
export const bindBrowserScenarioTools = ({
  provider,
  loadFailure,
}: BrowserScenarioToolOptions): ContractToolBindings => ({
  capture_browser_scenario: {
    admission: "sdk",
    summary: async (input, options) => {
      const scenario = browserScenarioSchema.safeParse(input);
      if (!scenario.success)
        return err(
          analysisInputErrorFromIssues(
            "capture_browser_scenario",
            scenario.error.issues,
            input,
            { cause: scenario.error },
          ),
        );
      return loadFailure === undefined
        ? captureBrowserScenario(provider, scenario.data, options)
        : err(
            optionalProviderUnavailable(
              loadFailure,
              "capture_browser_scenario",
            ),
          );
    },
  },
});

/** Passive JavaScript Inspector runtime observation tools. */
export const bindJavaScriptRuntimeTools = ({
  runtime,
  loadFailure,
}: JavaScriptRuntimeToolOptions): ContractToolBindings => ({
  list_javascript_runtime_targets: {
    admission: "sdk",
    unavailable: loadFailure,
    run: (input, options) =>
      listJavaScriptRuntimeTargets(runtime, input, options),
  },
  observe_javascript_runtime: {
    admission: "sdk",
    unavailable: loadFailure,
    run: (input, options) => observeJavaScriptRuntime(runtime, input, options),
  },
});
