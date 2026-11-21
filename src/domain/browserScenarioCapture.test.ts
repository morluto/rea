import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import { sanitizeBrowserUrl } from "./browserObservation.js";
import { browserScenarioCaptureSchema } from "./browserScenarioCapture.js";
import { DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS } from "./browserScenarioCaptureLimits.js";
import {
  browserScenarioCompletenessSchema,
  browserScenarioEventSchema,
  browserStepArtifactsSchema,
  type BrowserStepArtifacts,
} from "./browserScenarioCaptureValues.js";

const url = sanitizeBrowserUrl("https://example.test/resource");
const request = {
  sequence: 1,
  step_index: 0,
  kind: "request",
  transaction_id: "request-1",
  redirected_from_transaction_id: null,
  redirected_from_transaction_state: "root",
  method: "GET",
  url,
  resource_type: "document",
  header_names: [],
  status: null,
  failure: null,
} as const;

it("keeps unobserved redirect predecessors distinct from linked transactions", () => {
  const unknown = { ...request, redirected_from_transaction_state: "unknown" };
  expect(browserScenarioEventSchema.parse(unknown)).toEqual(unknown);
  const { redirected_from_transaction_state: _state, ...linked } = {
    ...request,
    redirected_from_transaction_id: "request-0",
  };
  expect(browserScenarioEventSchema.parse(linked)).toEqual(linked);
  for (const invalid of [
    { transaction_id: undefined },
    { redirected_from_transaction_id: undefined },
    { redirected_from_transaction_id: linked.redirected_from_transaction_id },
    { redirected_from_transaction_state: undefined },
  ]) {
    expect(
      browserScenarioEventSchema.safeParse({ ...unknown, ...invalid }).success,
    ).toBe(false);
  }
});

it("requires a three-digit status on responses and a failure reason on failed requests", () => {
  const response = { ...request, kind: "response", status: 999 };
  expect(browserScenarioEventSchema.parse(response)).toEqual(response);
  for (const status of [null, 99, 1000]) {
    expect(
      browserScenarioEventSchema.safeParse({ ...response, status }).success,
    ).toBe(false);
  }
  const failed = {
    ...request,
    kind: "request-failed",
    failure: "connection reset",
  };
  expect(browserScenarioEventSchema.parse(failed)).toEqual(failed);
  expect(
    browserScenarioEventSchema.safeParse({ ...failed, failure: null }).success,
  ).toBe(false);
  expect(
    browserScenarioEventSchema.safeParse({ ...failed, status: 500 }).success,
  ).toBe(false);
});

it("keeps WebSocket payload representation tied to its payload type", () => {
  const frame = {
    sequence: 1,
    step_index: 0,
    kind: "websocket-frame-received",
    url,
    payload_bytes: 3,
    truncated: false,
  };
  const text = { ...frame, payload_type: "text", payload_text: "abc" };
  const binary = { ...frame, payload_type: "binary", payload_text: null };
  expect(browserScenarioEventSchema.parse(text)).toEqual(text);
  expect(browserScenarioEventSchema.parse(binary)).toEqual(binary);
  expect(
    browserScenarioEventSchema.safeParse({
      ...binary,
      payload_text: text.payload_text,
    }).success,
  ).toBe(false);
});

const notRequested = { state: "not_requested" } as const;
const noArtifacts = {
  screenshot: notRequested,
  dom: notRequested,
  accessibility: notRequested,
  url: notRequested,
  history: notRequested,
  storage: notRequested,
};
const complete = {
  status: "complete",
  equality_eligible: true,
  missing_sections: [],
  truncated_sections: [],
};
const digest = "a".repeat(64);

it("requires a null fingerprint for redacted storage secrets", () => {
  const storage = { cookies: [], session_storage: [] };
  const entry = { name: "session", value_state: "redacted-secret" };
  const artifacts = (value_sha256: string | null) => ({
    ...noArtifacts,
    storage: {
      state: "captured",
      value: { ...storage, local_storage: [{ ...entry, value_sha256 }] },
    },
  });
  expect(browserStepArtifactsSchema.parse(artifacts(null))).toEqual(
    artifacts(null),
  );
  expect(browserStepArtifactsSchema.safeParse(artifacts(digest)).success).toBe(
    false,
  );
});

const captureFixture = (artifacts: BrowserStepArtifacts = noArtifacts) => ({
  browser: {
    mode: "launch",
    process_ownership: "provider-owned",
    cleanup: "terminated-owned-process",
    product: "Chromium",
    version: "fixture",
  },
  scenario: {
    start_origin: url.origin,
    action_count: 1,
    secret_references: [],
    network_content: {
      request_body: false,
      response_body: true,
      header_values: false,
    },
    event_families: ["network"],
    limits: DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS,
  },
  duration_ms: 0,
  steps: ["initial", "wait"].map((step_id, step_index) => ({
    step_index,
    step_id,
    action: step_index === 0 ? "initial" : "wait_for_timeout",
    elapsed_ms: 0,
    before_url: url,
    after_url: url,
    event_sequence_start: 1,
    event_sequence_end: 0,
    artifacts: step_index === 0 ? noArtifacts : artifacts,
    completeness: complete,
    status: "completed",
    error: null,
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
  completeness: complete,
  limitations: [],
});

it("preserves wide storage, history, text artifacts and metadata through capture parsing", () => {
  const text = "x".repeat(1_048_577);
  const longText = "detail".repeat(1_000);
  const fingerprint = {
    name: "entry",
    value_state: "hashed",
    value_sha256: digest,
  } as const;
  const artifacts: BrowserStepArtifacts = {
    ...noArtifacts,
    dom: {
      state: "captured",
      value: {
        sha256: createHash("sha256").update(text).digest("hex"),
        bytes: text.length,
        text,
      },
    },
    history: {
      state: "captured",
      value: {
        length: 257,
        current_url: url,
        navigation_entries: Array.from({ length: 257 }, () => ({
          type: "navigate",
          name: url,
        })),
      },
    },
    storage: {
      state: "captured",
      value: {
        cookies: Array.from({ length: 513 }, () => ({
          ...fingerprint,
          domain: "example.test",
          path: "/",
          secure: true,
          http_only: false,
          same_site: "Lax",
        })),
        local_storage: Array.from({ length: 513 }, () => fingerprint),
        session_storage: Array.from({ length: 513 }, () => fingerprint),
      },
    },
  };
  const base = captureFixture(artifacts);
  const capture = {
    ...base,
    browser: { ...base.browser, product: longText, version: longText },
    scenario: { ...base.scenario, secret_references: [longText] },
    steps: base.steps.map((step) => ({
      ...step,
      step_id: step.step_index === 0 ? step.step_id : longText,
      action: longText,
    })),
    limitations: Array.from({ length: 65 }, () => longText),
  };
  expect(browserScenarioCaptureSchema.parse(capture)).toEqual(capture);
});

it("requires resolved event limits and accounts for dropped events by kind", () => {
  const base = captureFixture();
  const capture = {
    ...base,
    scenario: {
      ...base.scenario,
      limits: {
        ...base.scenario.limits,
        max_total_event_allocation_bytes: 32 * 1024 * 1024,
      },
    },
    events: {
      ...base.events,
      dropped: 2,
      omissions: {
        by_kind: [
          {
            kind: "network-content",
            count: 1,
            reasons: ["max-total-event-allocation-bytes"],
          },
          { kind: "request", count: 1, reasons: ["max-network-transactions"] },
        ],
        network_transactions: [
          {
            transaction_id: "request-1",
            omitted_kinds: ["network-content"],
            reasons: ["max-total-event-allocation-bytes"],
          },
        ],
        network_transaction_range: {
          first_transaction_id: "request-2",
          last_transaction_id: "request-2",
          count: 1,
          reason: "max-network-transactions",
        },
      },
    },
    completeness: {
      ...complete,
      status: "incomplete",
      equality_eligible: false,
      missing_sections: ["events"],
    },
    limitations: ["Event coverage is incomplete."],
  };
  expect(browserScenarioCaptureSchema.parse(capture)).toEqual(capture);
  const wrongTotal = browserScenarioCaptureSchema.safeParse({
    ...capture,
    events: { ...capture.events, dropped: 3 },
  });
  expect(wrongTotal.error?.issues).toEqual([
    expect.objectContaining({ path: ["events", "omissions", "by_kind"] }),
  ]);
  for (const limits of [
    undefined,
    { max_events: base.scenario.limits.max_events },
  ]) {
    const unresolved = browserScenarioCaptureSchema.safeParse({
      ...capture,
      scenario: { ...capture.scenario, limits },
    });
    expect(unresolved.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: [
            "scenario",
            "limits",
            ...(limits ? ["max_total_event_allocation_bytes"] : []),
          ],
        }),
      ]),
    );
  }
});

it("derives equality eligibility from exact completeness state", () => {
  expect(
    browserScenarioCompletenessSchema.safeParse({
      ...complete,
      equality_eligible: false,
    }).success,
  ).toBe(false);
  expect(
    browserScenarioCompletenessSchema.safeParse({
      status: "incomplete",
      equality_eligible: false,
      missing_sections: ["dom"],
      truncated_sections: ["events"],
    }).success,
  ).toBe(false);
});
