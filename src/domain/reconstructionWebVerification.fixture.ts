import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";

import { browserScenarioSchema } from "./browserScenario.js";
import { browserScenarioCaptureSchema } from "./browserScenarioCapture.js";
import { compareBrowserCaptures } from "./browserCaptureComparison.js";
import { digestCanonicalValue } from "./canonicalDigest.js";
import { createEvidence, type Evidence } from "./evidence.js";
import { jsonObjectSchema } from "./jsonValue.js";
import { comparePngScreenshots } from "./pngVisualDiff.js";
import {
  readWebScenarioSource,
  WEB_COMPARISON_PROVIDER,
  webCaptureSourceInput,
  webScreenshotSourceArtifact,
  webCaptureComparisonPolicySchema,
} from "./webComparisonSources.js";
import {
  createWebScreenshotArtifact,
  type WebScreenshotArtifact,
} from "./webScreenshot.js";

/** Small valid RGBA images with known pixel differences. */
export const webVerificationImage = (
  secondRed = 0,
  width = 2,
): WebScreenshotArtifact => {
  const chunk = (name: string, payload: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), payload]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const pixels = Buffer.alloc(1 + width * 4);
  for (let index = 0; index < width; index++) pixels[1 + index * 4 + 3] = 255;
  if (width > 1) pixels[5] = secondRed;
  return createWebScreenshotArtifact(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(pixels)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
};

export const webVerificationScenario = (
  options: {
    duration?: number;
    origin?: string;
    dom?: string;
    width?: number;
    screenshot?: WebScreenshotArtifact | null;
    incomplete?: boolean;
  } = {},
): Evidence => {
  const origin = options.origin ?? "https://original.example.test";
  const scenario = browserScenarioSchema.parse({
    browser: {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "page",
    },
    start_url: { url: `${origin}/settings` },
    environment: {
      viewport: {
        width: options.width ?? 1280,
        height: 720,
        device_scale_factor: 1,
      },
    },
    actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
    capture: {
      after_each_step: ["dom", "url", "screenshot"],
      at_end: ["dom", "url", "screenshot"],
      events: ["console"],
    },
  });
  const location = {
    url: `${origin}/settings`,
    origin,
    query_parameter_names: [],
    redacted: false,
  };
  const text = options.dom ?? "<main>Ready</main>";
  const textBytes = Buffer.from(text);
  const screenshot =
    options.screenshot === undefined
      ? webVerificationImage()
      : options.screenshot;
  const complete = {
    status: "complete",
    equality_eligible: true,
    missing_sections: [],
    truncated_sections: [],
  };
  const capture = browserScenarioCaptureSchema.parse({
    browser: {
      mode: "connect",
      process_ownership: "external",
      cleanup: "disconnected-external",
      product: "Chromium",
      version: "149.0",
    },
    scenario: {
      start_origin: origin,
      action_count: 1,
      secret_references: [],
      network_content: scenario.capture.network,
      limits: scenario.capture.limits,
      event_families: ["console"],
    },
    duration_ms: options.duration ?? 1,
    steps: ["scenario_start", "wait"].map((stepId, index) => ({
      step_index: index,
      step_id: stepId,
      action: index === 0 ? "scenario_start" : "wait_for_timeout",
      status: "completed",
      error: null,
      elapsed_ms: index,
      before_url: location,
      after_url: location,
      event_sequence_start: 1,
      event_sequence_end: 0,
      artifacts: {
        screenshot:
          screenshot === null
            ? { state: "not_requested" }
            : { state: "captured", value: screenshot },
        dom: {
          state: "captured",
          value: {
            sha256: createHash("sha256").update(textBytes).digest("hex"),
            bytes: textBytes.length,
            text,
          },
        },
        url: { state: "captured", value: location },
        accessibility: { state: "not_requested" },
        history: { state: "not_requested" },
        storage: { state: "not_requested" },
      },
      completeness: complete,
    })),
    events: {
      retained: 0,
      dropped: 0,
      items: [],
      omissions: {
        by_kind: [],
        network_transactions: [],
        network_transaction_range: null,
      },
    },
    completeness: options.incomplete
      ? {
          status: "incomplete",
          equality_eligible: false,
          missing_sections: ["dom"],
          truncated_sections: [],
        }
      : complete,
    limitations: [],
  });
  return createEvidence(
    undefined,
    { id: "rea-browser-scenario", name: "Browser scenario", version: "1" },
    {
      operation: "capture_browser_scenario",
      predicateType: "rea.browser-scenario-capture",
      parameters: {
        ...jsonObjectSchema.parse(scenario),
        scenario_sha256: digestCanonicalValue(scenario, "Browser scenario"),
      },
      result: capture,
      confidence: "observed",
      authority: "controlled-replay",
      environment: {
        id: "Chromium@149.0",
        platform: "unknown",
        architecture: "unknown",
        isolation: "none",
      },
    },
  );
};

export const webVerificationCaptureComparison = (
  left: Evidence,
  right: Evidence,
  policyInput: unknown = {},
): Evidence => {
  const policy = webCaptureComparisonPolicySchema.parse(policyInput);
  const result = compareBrowserCaptures(
    webCaptureSourceInput(left, right, policy),
  );
  return createEvidence(undefined, WEB_COMPARISON_PROVIDER, {
    operation: "compare_web_captures",
    predicateType: "rea.web-capture-diff",
    parameters: {
      left_evidence_id: left.evidence_id,
      right_evidence_id: right.evidence_id,
      ...jsonObjectSchema.parse(policy),
    },
    result,
    confidence: "derived",
    authority: "analyst-inference",
    environment: null,
    evidenceLinks: [...new Set([left.evidence_id, right.evidence_id])].sort(),
  });
};

export const webVerificationScreenshotComparison = (
  left: Evidence,
  right: Evidence,
  threshold = 0,
): Evidence => {
  const before = webScreenshotSourceArtifact(left, "wait");
  const after = webScreenshotSourceArtifact(right, "wait");
  const result =
    before === undefined || after === undefined
      ? {
          status: "unavailable",
          reason: "The selected screenshot was not captured on both sources.",
          limitations: [],
        }
      : comparePngScreenshots({ before, after, channel_threshold: threshold });
  return createEvidence(undefined, WEB_COMPARISON_PROVIDER, {
    operation: "compare_web_screenshots",
    predicateType: "rea.web-screenshot-diff",
    parameters: {
      left_evidence_id: left.evidence_id,
      right_evidence_id: right.evidence_id,
      channel_threshold: threshold,
      step_id: "wait",
    },
    result,
    confidence: "derived",
    authority: "analyst-inference",
    environment: null,
    evidenceLinks: [...new Set([left.evidence_id, right.evidence_id])].sort(),
  });
};

/** Rebuild a valid Evidence identity after an intentional fixture mutation. */
export const webVerificationMutation = (
  source: Evidence,
  changes: Partial<
    Pick<
      Evidence,
      | "parameters"
      | "normalized_result"
      | "evidence_links"
      | "authority"
      | "confidence"
    >
  >,
): Evidence =>
  createEvidence(undefined, source.provider, {
    operation: source.operation,
    predicateType: source.predicate_type,
    parameters: changes.parameters ?? source.parameters,
    result: changes.normalized_result ?? source.normalized_result,
    evidenceLinks: changes.evidence_links ?? source.evidence_links,
    authority: changes.authority ?? source.authority,
    confidence: changes.confidence ?? source.confidence,
    environment: source.environment,
  });

export const webVerificationCapture = (source: Evidence) =>
  readWebScenarioSource(source).capture;
