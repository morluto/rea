import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { compareBrowserScenarios } from "./browserScenarioDiff.js";
import { networkContentCoverageReason } from "./browserScenarioDiffEvidence.js";
import { scenarioNetworkCoverageReason } from "./browserScenarioNetworkComparison.js";
import {
  compareBrowserScenariosInputSchema,
  browserScenarioDiffSchema,
} from "./browserScenarioDiffValues.js";
import {
  browserScenarioCaptureSchema,
  retainedBrowserScenarioCaptureSchema,
  type BrowserScenarioCapture,
} from "./browserScenarioCapture.js";
import { DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS } from "./browserScenarioCaptureLimits.js";
import { BROWSER_STORAGE_FINGERPRINT_VERSION } from "./browserScenarioCaptureValues.js";

const noEventOmissions = {
  by_kind: [],
  network_transactions: [],
  network_transaction_range: null,
} as const;

it("admits legacy event-family omission only for retained capture consumers", () => {
  const current = scenarioCapture({});
  const { event_families: _selection, ...scenario } = current.scenario;
  const legacy = { ...current, scenario };
  expect(browserScenarioCaptureSchema.safeParse(legacy).success).toBe(false);
  const admitted = retainedBrowserScenarioCaptureSchema.parse(legacy);
  expect(admitted.scenario.event_families).toBeUndefined();
  for (const [before_scenario, after_scenario] of [
    [current, legacy],
    [legacy, current],
    [legacy, legacy],
  ]) {
    const result = compareBrowserScenarios(
      compareBrowserScenariosInputSchema.parse({
        before_scenario,
        after_scenario,
      }),
    );
    expect(result.overall_status).toBe("unknown");
    expect(
      result.steps
        .flatMap((step) => step.artifact_diffs)
        .filter(({ artifact }) => artifact === "events"),
    ).toContainEqual(
      expect.objectContaining({
        status: "unknown",
        reason: expect.stringContaining("not recorded"),
      }),
    );
  }
});

const networkCapture = (sourceSequence: number, receiptStep: number) => {
  const base = scenarioCapture({});
  const events = [
    {
      sequence: sourceSequence,
      step_index: 0,
      kind: "request",
      method: "POST",
      url: {
        url: "https://app.example.test/api",
        origin: "https://app.example.test",
        query_parameter_names: [],
        redacted: false,
      },
      resource_type: "fetch",
      transaction_id: "request-1",
      redirected_from_transaction_id: null,
      redirected_from_transaction_state: "root",
      header_names: [],
      status: null,
      failure: null,
    },
    {
      sequence: sourceSequence + 1,
      step_index: receiptStep,
      kind: "network-content",
      transaction_id: "request-1",
      phase: "request",
      source_event_sequence: sourceSequence,
      headers: { state: "not_requested" },
      body: {
        state: "captured",
        representation: "browser-exposed-request-bytes",
        encoding: "base64",
        content: "eA==",
        bytes: 1,
        sha256: createHash("sha256").update("x").digest("hex"),
        media_type: null,
        redacted: false,
      },
    },
  ];
  return browserScenarioCaptureSchema.parse({
    ...base,
    scenario: {
      ...base.scenario,
      network_content: {
        request_body: true,
        response_body: false,
        header_values: false,
      },
      event_families: ["network"],
    },
    events: {
      items: events,
      retained: 2,
      dropped: 0,
      omissions: noEventOmissions,
    },
  });
};

it("normalizes network content anchors and attributes late content to its source step", () => {
  const before = networkCapture(3, 0);
  const after = networkCapture(90, 1);
  expect(
    compareBrowserScenarios(
      compareBrowserScenariosInputSchema.parse({
        before_scenario: before,
        after_scenario: after,
      }),
    ).overall_status,
  ).toBe("unchanged");
  const content = after.events.items[1];
  if (content?.kind !== "network-content")
    throw new Error("Expected content fixture");
  for (const mutation of [
    { transaction_id: "another-request" },
    { source_event_sequence: 91 },
    { phase: "response" },
  ])
    expect(
      browserScenarioCaptureSchema.safeParse({
        ...after,
        events: {
          ...after.events,
          items: [after.events.items[0], { ...content, ...mutation }],
        },
      }).success,
    ).toBe(false);
});

it("reports content-selection mismatch as unknown instead of a website change", () => {
  const withBody = networkCapture(1, 0);
  const metadataOnly = browserScenarioCaptureSchema.parse({
    ...withBody,
    scenario: {
      ...withBody.scenario,
      network_content: {
        request_body: false,
        response_body: false,
        header_values: false,
      },
    },
    events: {
      ...withBody.events,
      items: withBody.events.items.filter(
        (event) => event.kind !== "network-content",
      ),
      retained: 1,
    },
  });
  const compared = compareBrowserScenarios(
    compareBrowserScenariosInputSchema.parse({
      before_scenario: metadataOnly,
      after_scenario: withBody,
    }),
  );
  expect(compared.overall_status).toBe("unknown");
  expect(compared.steps.flatMap((step) => step.artifact_diffs)).toContainEqual(
    expect.objectContaining({
      artifact: "events",
      status: "unknown",
      reason: expect.stringContaining("content selections differ"),
    }),
  );
  for (const networkContent of [undefined, {}, { request_body: false }])
    expect(
      compareBrowserScenariosInputSchema.safeParse({
        before_scenario: {
          ...metadataOnly,
          scenario: {
            ...metadataOnly.scenario,
            network_content: networkContent,
          },
        },
        after_scenario: withBody,
      }).success,
    ).toBe(false);
});

it("reports event-family selection mismatch as unknown", () => {
  const consoleOnly = scenarioCapture({});
  const withFamilies = (
    capture: BrowserScenarioCapture,
    families: BrowserScenarioCapture["scenario"]["event_families"],
  ) =>
    browserScenarioCaptureSchema.parse({
      ...capture,
      scenario: { ...capture.scenario, event_families: families },
    });
  const compare = (
    before: BrowserScenarioCapture,
    after: BrowserScenarioCapture,
  ) =>
    compareBrowserScenarios(
      compareBrowserScenariosInputSchema.parse({
        before_scenario: before,
        after_scenario: after,
      }),
    );
  const eventDiffs = (compared: ReturnType<typeof compare>) =>
    compared.steps
      .flatMap((step) => step.artifact_diffs)
      .filter(({ artifact }) => artifact === "events");

  const widened = withFamilies(consoleOnly, ["page-errors", "console"]);
  const mismatched = compare(consoleOnly, widened);
  expect(mismatched.overall_status).toBe("unknown");
  expect(eventDiffs(mismatched)).toContainEqual(
    expect.objectContaining({
      status: "unknown",
      before_state: "captured",
      after_state: "captured",
      reason: expect.stringContaining(
        "Event family selections differ (console before, console, page-errors after)",
      ),
    }),
  );
  expect(
    compare(
      withFamilies(consoleOnly, ["console", "page-errors"]),
      withFamilies(consoleOnly, ["page-errors", "console"]),
    ).overall_status,
  ).toBe("unchanged");

  expect(
    compareBrowserScenariosInputSchema.safeParse({
      before_scenario: {
        ...consoleOnly,
        scenario: { ...consoleOnly.scenario, event_families: ["dialogs"] },
      },
      after_scenario: consoleOnly,
    }).success,
  ).toBe(false);

  const quiet = browserScenarioCaptureSchema.parse({
    ...withFamilies(consoleOnly, []),
    events: { retained: 0, dropped: 0, items: [], omissions: noEventOmissions },
  });
  const differentEvents = compare(quiet, widened);
  expect(differentEvents.overall_status).toBe("unknown");
  expect(eventDiffs(differentEvents).map(({ status }) => status)).toEqual([
    "unknown",
    "unknown",
  ]);

  const both = eventDiffs(compare(networkCapture(1, 0), consoleOnly));
  expect(both).toContainEqual(
    expect.objectContaining({
      reason: expect.stringMatching(
        /Event family selections differ.*content selections differ/u,
      ),
    }),
  );
  for (const diff of both) {
    expect(diff.reason?.match(/Event family selections differ/gu)).toHaveLength(
      1,
    );
    expect(
      diff.reason?.match(/Network content selections differ/gu),
    ).toHaveLength(1);
  }
});

it("retains network coverage guidance alongside independent console changes", () => {
  const network = networkCapture(1, 0);
  const consoleEvent = scenarioCapture({}).events.items[0];
  if (consoleEvent?.kind !== "console")
    throw new Error("Expected console fixture");

  const capture = ({
    unknownPredecessor = false,
    responseBody = false,
    text = consoleEvent.text,
  } = {}) =>
    browserScenarioCaptureSchema.parse({
      ...network,
      scenario: {
        ...network.scenario,
        event_families: ["network", "console"],
        network_content: {
          ...network.scenario.network_content,
          response_body: responseBody,
        },
      },
      events: {
        ...network.events,
        retained: 3,
        items: [
          ...network.events.items.map((event) =>
            unknownPredecessor && event.kind === "request"
              ? { ...event, redirected_from_transaction_state: "unknown" }
              : event,
          ),
          { ...consoleEvent, sequence: 3, text },
        ],
      },
    });
  const compare = (
    before_scenario: BrowserScenarioCapture,
    after_scenario: BrowserScenarioCapture,
  ) =>
    compareBrowserScenarios(
      compareBrowserScenariosInputSchema.parse({
        before_scenario,
        after_scenario,
      }),
    );

  const original = capture();
  const matching = compare(original, original);
  expect(matching.overall_status).toBe("unchanged");
  expect(matching.artifact_diffs.total).toBe(0);
  const missing = capture({ unknownPredecessor: true });
  const responseSelected = capture({ responseBody: true });

  for (const { before, quietAfter, changedAfter, reason } of [
    {
      before: original,
      quietAfter: responseSelected,
      changedAfter: capture({ responseBody: true, text: "settings-failed" }),
      reason: networkContentCoverageReason(original, responseSelected),
    },
    {
      before: missing,
      quietAfter: missing,
      changedAfter: capture({
        unknownPredecessor: true,
        text: "settings-failed",
      }),
      reason: scenarioNetworkCoverageReason(missing),
    },
  ]) {
    if (reason === undefined)
      throw new Error("Expected incomplete network coverage");
    const quiet = compare(before, quietAfter);
    expect(quiet.overall_status).toBe("unknown");
    const changed = compare(before, changedAfter);
    expect(changed.overall_status).toBe("changed");

    for (const [result, consoleStatus] of [
      [quiet, "unknown"],
      [changed, "changed"],
    ] as const) {
      const diffs = result.steps.flatMap(
        ({ artifact_diffs }) => artifact_diffs,
      );
      expect(diffs.map(({ artifact, status }) => [artifact, status])).toEqual([
        ["events", "unknown"],
        ["events", consoleStatus],
      ]);
      for (const diff of diffs) {
        expect(diff.reason).toBe(reason);
        expect(diff.before_sha256).not.toBeNull();
        expect(diff.after_sha256).not.toBeNull();
        if (diff.status === "changed")
          expect(diff.before_sha256).not.toBe(diff.after_sha256);
        else expect(diff.before_sha256).toBe(diff.after_sha256);
      }
    }
  }
});

const concurrentCapture = (
  requestOrder: readonly ("a" | "b")[],
  statuses: Readonly<Record<"a" | "b", number>>,
  responseStep = 0,
  responseOrder: readonly ("a" | "b")[] = requestOrder,
  redirect = false,
) => {
  const base = scenarioCapture({});
  const network = (path: "a" | "b") => ({
    step_index: 0,
    transaction_id: `request-${String(requestOrder.indexOf(path) + 1)}`,
    redirected_from_transaction_id:
      redirect && path === "b"
        ? `request-${String(requestOrder.indexOf("a") + 1)}`
        : null,
    ...(!redirect || path !== "b"
      ? { redirected_from_transaction_state: "root" as const }
      : {}),
    method: "GET",
    url: {
      url: `https://app.example.test/${path}.js`,
      origin: "https://app.example.test",
      query_parameter_names: [],
      redacted: false,
    },
    resource_type: "script",
    header_names: [],
    failure: null,
  });
  const request = (path: "a" | "b") => ({
    ...network(path),
    kind: "request",
    status: null,
  });
  const response = (path: "a" | "b") => ({
    ...network(path),
    step_index: responseStep,
    kind: "response",
    status: statuses[path],
  });
  const events = (
    redirect
      ? requestOrder.flatMap((path) => [request(path), response(path)])
      : [...requestOrder.map(request), ...responseOrder.map(response)]
  ).map((event, index) => ({ ...event, sequence: index + 1 }));
  return browserScenarioCaptureSchema.parse({
    ...base,
    scenario: { ...base.scenario, event_families: ["network"] },
    events: {
      items: events,
      retained: events.length,
      dropped: 0,
      omissions: noEventOmissions,
    },
  });
};

const redirectChainCapture = (swapLeaves = false, reverseReceipt = false) => {
  const base = scenarioCapture({});
  const nodes = [
    { id: "root-a", parent: null, path: "first-a", status: 301 },
    { id: "root-b", parent: null, path: "first-b", status: 302 },
    { id: "middle-a", parent: "root-a", path: "same-middle", status: 307 },
    { id: "middle-b", parent: "root-b", path: "same-middle", status: 307 },
    {
      id: "leaf-a",
      parent: swapLeaves ? "middle-b" : "middle-a",
      path: "last-a",
      status: 200,
    },
    {
      id: "leaf-b",
      parent: swapLeaves ? "middle-a" : "middle-b",
      path: "last-b",
      status: 200,
    },
  ];
  const events = (reverseReceipt ? [...nodes].reverse() : nodes)
    .flatMap((node) => {
      const network = {
        step_index: 0,
        transaction_id: (reverseReceipt ? "renamed-" : "") + node.id,
        redirected_from_transaction_id:
          node.parent === null
            ? null
            : (reverseReceipt ? "renamed-" : "") + node.parent,
        ...(node.parent === null
          ? { redirected_from_transaction_state: "root" as const }
          : {}),
        method: "GET",
        url: {
          url: `https://app.example.test/${node.path}`,
          origin: "https://app.example.test",
          query_parameter_names: [],
          redacted: false,
        },
        resource_type: "document",
        header_names: [],
        failure: null,
      };
      return [
        { ...network, kind: "request", status: null },
        { ...network, kind: "response", status: node.status },
      ];
    })
    .map((event, index) => ({ ...event, sequence: index + 1 }));
  return browserScenarioCaptureSchema.parse({
    ...base,
    scenario: { ...base.scenario, event_families: ["network"] },
    events: {
      items: events,
      retained: events.length,
      dropped: 0,
      omissions: noEventOmissions,
    },
  });
};

describe("browser scenario network event order", () => {
  it("retains multi-hop redirect ancestry while ignoring IDs and concurrent receipt order", () => {
    const compare = (after: BrowserScenarioCapture) =>
      compareBrowserScenarios(
        compareBrowserScenariosInputSchema.parse({
          before_scenario: redirectChainCapture(),
          after_scenario: after,
        }),
      );
    expect(compare(redirectChainCapture(false, true)).overall_status).toBe(
      "unchanged",
    );
    expect(compare(redirectChainCapture(true)).overall_status).toBe("changed");
  });

  it("keeps duplicate request identities incomparable without dropping occurrences", () => {
    const capture = concurrentCapture(["a", "b"], { a: 200, b: 404 });
    const request = capture.events.items.find(
      (event) => event.kind === "request",
    );
    if (request === undefined) throw new Error("Expected request fixture");
    const ambiguous = browserScenarioCaptureSchema.parse({
      ...capture,
      events: {
        ...capture.events,
        retained: capture.events.retained + 1,
        items: [
          ...capture.events.items,
          { ...request, sequence: capture.events.retained + 1, step_index: 1 },
        ],
      },
    });
    for (const [before_scenario, after_scenario] of [
      [ambiguous, ambiguous],
      [ambiguous, capture],
      [capture, ambiguous],
    ] as const) {
      const input = compareBrowserScenariosInputSchema.parse({
        before_scenario,
        after_scenario,
      });
      const compared = compareBrowserScenarios(input);
      expect(compared.overall_status).toBe("unknown");
      expect(
        compared.steps.flatMap((step) => step.artifact_diffs),
      ).toContainEqual(
        expect.objectContaining({
          artifact: "events",
          status: "unknown",
          reason: expect.stringContaining("Multiple requests share"),
        }),
      );
      expect(input.before_scenario.events.items).toEqual(
        before_scenario.events.items,
      );
      expect(input.after_scenario.events.items).toEqual(
        after_scenario.events.items,
      );
    }
  });

  it("keeps missing and cyclic redirect ancestry incomparable", () => {
    for (const predecessor of ["missing", "middle-a", null]) {
      const capture = redirectChainCapture();
      const events = capture.events.items.map((event) =>
        "transaction_id" in event && event.transaction_id === "root-a"
          ? {
              ...event,
              redirected_from_transaction_id: predecessor,
              redirected_from_transaction_state:
                predecessor === null ? ("unknown" as const) : undefined,
            }
          : event,
      );
      const broken = browserScenarioCaptureSchema.parse({
        ...capture,
        events: { ...capture.events, items: events },
      });
      const compared = compareBrowserScenarios(
        compareBrowserScenariosInputSchema.parse({
          before_scenario: broken,
          after_scenario: broken,
        }),
      );
      expect(compared.overall_status).toBe("unknown");
      expect(
        compared.steps.flatMap((step) => step.artifact_diffs),
      ).toContainEqual(
        expect.objectContaining({
          artifact: "events",
          status: "unknown",
          reason: expect.stringContaining("Redirect"),
        }),
      );
    }
  });

  it("keeps contradictory phase ancestry unknown", () => {
    const capture = concurrentCapture(["a", "b"], { a: 200, b: 404 });
    const events = capture.events.items.map((event) =>
      event.kind === "response" && event.transaction_id === "request-2"
        ? {
            ...event,
            redirected_from_transaction_id: "request-1",
            redirected_from_transaction_state: undefined,
          }
        : event,
    );
    const malformed = browserScenarioCaptureSchema.parse({
      ...capture,
      events: { ...capture.events, items: events },
    });
    const compared = compareBrowserScenarios(
      compareBrowserScenariosInputSchema.parse({
        before_scenario: malformed,
        after_scenario: malformed,
      }),
    );
    expect(compared.overall_status).toBe("unknown");
    expect(
      compared.steps.flatMap((step) => step.artifact_diffs),
    ).toContainEqual(
      expect.objectContaining({
        artifact: "events",
        status: "unknown",
        reason: expect.stringContaining("Redirect predecessor"),
      }),
    );
  });
});

describe("browser scenario network comparison stability", () => {
  it("keeps normalization away from generated network fingerprints", () => {
    const rules = [..."0123456789abcdef"].map((match, index) => ({
      rule_id: `remove-fingerprint-hex-${String(index)}`,
      artifacts: ["events"] as const,
      match,
      replacement: "",
    }));
    const compared = compareBrowserScenarios(
      compareBrowserScenariosInputSchema.parse({
        before_scenario: concurrentCapture(["a", "b"], {
          a: 200,
          b: 404,
        }),
        after_scenario: concurrentCapture(["a", "b"], {
          a: 201,
          b: 404,
        }),
        normalization: { rules },
      }),
    );
    expect(compared.overall_status).toBe("changed");
  });

  it("compares concurrent network transactions without receipt order, receipt step or capture-local IDs", () => {
    const compare = (
      before: BrowserScenarioCapture,
      after: BrowserScenarioCapture,
    ) =>
      compareBrowserScenarios(
        compareBrowserScenariosInputSchema.parse({
          before_scenario: before,
          after_scenario: after,
        }),
      ).overall_status;
    const statuses = { a: 200, b: 404 };

    expect(
      compare(
        concurrentCapture(["a", "b"], statuses),
        concurrentCapture(["b", "a"], statuses, 1, ["a", "b"]),
      ),
    ).toBe("unchanged");
    expect(
      compare(
        concurrentCapture(["a", "b"], statuses),
        concurrentCapture(["b", "a"], { a: 404, b: 200 }),
      ),
    ).toBe("changed");
    expect(
      compare(
        concurrentCapture(["a", "b"], statuses, 0, ["a", "b"]),
        concurrentCapture(["a", "b"], statuses, 0, ["b", "a"]),
      ),
    ).toBe("unchanged");
    // Redirect linkage is distinct from independent concurrent transactions.
    expect(
      compare(
        concurrentCapture(["a", "b"], statuses),
        concurrentCapture(["a", "b"], statuses, 0, ["a", "b"], true),
      ),
    ).toBe("changed");
  });
});

describe("browser scenario network request times", () => {
  /** A two-request capture whose `a` request finished and whose `b` request failed with `failure`. */
  const ended = (failure = "net::ERR_ABORTED"): BrowserScenarioCapture => {
    const capture = concurrentCapture(["a", "b"], { a: 200, b: 404 });
    let sequence = Math.max(...capture.events.items.map((e) => e.sequence));
    const terminal = capture.events.items.flatMap((event) =>
      event.kind === "request"
        ? [
            event.url.url.endsWith("/a.js")
              ? {
                  ...event,
                  sequence: ++sequence,
                  kind: "request-finished" as const,
                }
              : {
                  ...event,
                  sequence: ++sequence,
                  kind: "request-failed" as const,
                  failure,
                },
          ]
        : [],
    );
    return browserScenarioCaptureSchema.parse({
      ...capture,
      events: {
        ...capture.events,
        retained: capture.events.items.length + terminal.length,
        items: [...capture.events.items, ...terminal],
      },
    });
  };

  /** The same capture with every request observed, started and timed `offset` ms later. */
  const timed = (
    capture: BrowserScenarioCapture,
    offset: number,
  ): BrowserScenarioCapture =>
    browserScenarioCaptureSchema.parse({
      ...capture,
      events: {
        ...capture.events,
        items: capture.events.items.map((event) =>
          event.kind === "request"
            ? {
                ...event,
                observed_at: new Date(
                  Date.parse("2026-10-24T05:00:00.000Z") + offset,
                ).toISOString(),
              }
            : event.kind === "request-finished" ||
                event.kind === "request-failed"
              ? {
                  ...event,
                  started_at: new Date(
                    Date.parse("2026-10-24T04:59:59.990Z") + offset,
                  ).toISOString(),
                  elapsed_ms: 3 + offset,
                }
              : event,
        ),
      },
    });

  const compare = (
    before: BrowserScenarioCapture,
    after: BrowserScenarioCapture,
  ) =>
    compareBrowserScenarios(
      compareBrowserScenariosInputSchema.parse({
        before_scenario: before,
        after_scenario: after,
      }),
    );

  it("ignores when requests were observed, started and how long they took", () => {
    const early = timed(ended(), 0);
    const late = timed(ended(), 7_000);
    const terminal = early.events.items.filter(
      (event) =>
        event.kind === "request-finished" || event.kind === "request-failed",
    );
    expect(terminal.map(({ kind }) => kind).sort()).toEqual([
      "request-failed",
      "request-finished",
    ]);
    for (const event of terminal)
      expect(event).toMatchObject({
        started_at: expect.any(String),
        elapsed_ms: expect.any(Number),
      });
    const compared = compare(early, late);
    expect(compared.overall_status).toBe("unchanged");
    expect(compared.normalization.built_in_rules).toContain(
      "ignore_network_request_timing",
    );
    // A capture made before request times were recorded compares with a timed one.
    expect(compare(ended(), late).overall_status).toBe("unchanged");
  });

  it("still compares the rest of a timed completion event", () => {
    expect(
      compare(
        timed(ended(), 0),
        timed(ended("net::ERR_CONNECTION_RESET"), 7_000),
      ).overall_status,
    ).toBe("changed");
  });
});

describe("browser scenario comparison", () => {
  it("applies committed cascading rules in canonical order and ignores volatile fields", () => {
    const before = scenarioCapture({
      domText: "<main data-build='build-123'>Settings</main>",
      elapsedMs: 11,
      eventSequence: 3,
    });
    const after = scenarioCapture({
      domText: "<main data-build='build-456'>Settings</main>",
      elapsedMs: 900,
      eventSequence: 88,
    });
    const rules = [
      {
        rule_id: "new-build",
        artifacts: ["url", "dom"] as const,
        match: "build-456",
        replacement: "build-123",
      },
      {
        rule_id: "old-build",
        artifacts: ["dom"] as const,
        match: "build-123",
        replacement: "[BUILD]",
      },
    ];

    const compared = compareBrowserScenarios(
      compareBrowserScenariosInputSchema.parse({
        before_scenario: before,
        after_scenario: after,
        normalization: { rules },
      }),
    );
    const reordered = compareBrowserScenarios(
      compareBrowserScenariosInputSchema.parse({
        before_scenario: before,
        after_scenario: after,
        normalization: {
          rules: [...rules].reverse().map((rule) => ({
            ...rule,
            artifacts: [...rule.artifacts].reverse(),
          })),
        },
      }),
    );

    expect(compared.overall_status).toBe("unchanged");
    expect(compared.alignment.status).toBe("aligned");
    expect(compared.artifact_diffs.total).toBe(0);
    expect(compared.normalization).toMatchObject({
      rules: [
        { rule_id: "new-build", artifacts: ["dom", "url"] },
        { rule_id: "old-build", artifacts: ["dom"] },
      ],
    });
    expect(reordered).toEqual(compared);
  });

  it("exposes action mismatches and normalized artifact-level changes", () => {
    const before = scenarioCapture({
      domText: "<main>Settings</main>",
    });
    const after = scenarioCapture({
      action: "dblclick",
      domText: "<main>Advanced settings</main>",
    });

    const compared = compareBrowserScenarios(
      compareBrowserScenariosInputSchema.parse({
        before_scenario: before,
        after_scenario: after,
      }),
    );
    const step = compared.steps.find(
      ({ step_id: stepId }) => stepId === "open-settings",
    );

    expect(compared.overall_status).toBe("changed");
    expect(compared.alignment).toMatchObject({
      status: "partial",
      failures: [
        expect.objectContaining({
          code: "action_mismatch",
          step_id: "open-settings",
        }),
      ],
    });
    expect(step).toMatchObject({
      status: "changed",
      artifact_diffs: [
        expect.objectContaining({
          artifact: "action_state",
          status: "changed",
        }),
        expect.objectContaining({ artifact: "dom", status: "changed" }),
      ],
    });
    expect(compared.artifact_diffs).toEqual({ total: 2 });
  });
});

describe("browser scenario comparison text values", () => {
  it("accepts long normalization values and comparison diagnostics", () => {
    const longText = "x".repeat(5_000);
    const ruleId = "r".repeat(100);
    const capture = scenarioCapture({});
    const compared = compareBrowserScenarios(
      compareBrowserScenariosInputSchema.parse({
        before_scenario: capture,
        after_scenario: capture,
        normalization: {
          rules: [
            {
              rule_id: ruleId,
              artifacts: ["dom"],
              match: longText,
              replacement: longText,
            },
          ],
        },
      }),
    );
    const stepId = "s".repeat(100);
    const diagnostic = browserScenarioDiffSchema.parse({
      ...compared,
      alignment: {
        ...compared.alignment,
        before_only: [stepId],
        after_only: [stepId],
        failures: [
          {
            code: "missing_before_step",
            step_id: stepId,
            reason: longText,
          },
        ],
      },
      steps: compared.steps.map((step) => ({
        ...step,
        step_id: stepId,
        artifact_diffs: [
          {
            artifact: "dom",
            status: "unknown",
            before_state: "missing",
            after_state: "missing",
            before_sha256: null,
            after_sha256: null,
            reason: longText,
          },
        ],
      })),
      limitations: [longText],
    });

    expect(diagnostic.normalization.rules[0]).toMatchObject({
      rule_id: ruleId,
      match: longText,
      replacement: longText,
    });
    expect(diagnostic.alignment.failures[0]?.reason).toBe(longText);
    expect(diagnostic.steps[0]?.artifact_diffs[0]?.reason).toBe(longText);
    expect(diagnostic.limitations).toEqual([longText]);
  });
});

describe("browser scenario comparison validation", () => {
  it("does not accept caller limits that would omit difference records", () => {
    const capture = scenarioCapture({});
    expect(
      compareBrowserScenariosInputSchema.safeParse({
        before_scenario: capture,
        after_scenario: capture,
        max_changes: 1,
      }).success,
    ).toBe(false);
  });

  it("returns every aligned step of long scenarios", () => {
    const before = multiStepScenarioCapture(130, "before");
    const after = multiStepScenarioCapture(130, "after");
    const result = compareBrowserScenarios(
      compareBrowserScenariosInputSchema.parse({
        before_scenario: before,
        after_scenario: after,
      }),
    );

    expect(result.alignment).toMatchObject({
      status: "aligned",
      aligned_steps: 131,
    });
    expect(result.steps).toHaveLength(131);
    expect(result.steps.at(-1)).toMatchObject({
      before_step_index: 130,
      after_step_index: 130,
      status: "changed",
    });
    expect(result.artifact_diffs.total).toBe(130);
  });

  it("aligns reordered unique steps while distinguishing missing and ambiguous IDs", () => {
    const capture = scenarioCapture({});
    const action = capture.steps[1];
    if (action === undefined) throw new Error("Expected scenario action step");
    const withSteps = (ids: readonly string[]) => ({
      ...capture,
      scenario: { ...capture.scenario, action_count: ids.length },
      steps: [
        capture.steps[0],
        ...ids.map((step_id, index) => ({
          ...action,
          step_id,
          step_index: index + 1,
          event_sequence_start: 1,
          event_sequence_end: 0,
        })),
      ],
      events: { ...capture.events, retained: 0, items: [] },
    });
    const compared = compareBrowserScenarios(
      compareBrowserScenariosInputSchema.parse({
        before_scenario: withSteps([
          "keep-z",
          "ambiguous-before",
          "keep-a",
          "before-only",
          "ambiguous-before",
          "ambiguous-after",
        ]),
        after_scenario: withSteps([
          "keep-a",
          "ambiguous-after",
          "keep-z",
          "after-only",
          "ambiguous-after",
          "ambiguous-before",
        ]),
      }),
    );

    expect(compared.overall_status).toBe("unknown");
    expect(compared.alignment).toMatchObject({
      status: "partial",
      aligned_steps: 3,
      before_only: ["before-only"],
      after_only: ["after-only"],
    });
    expect(
      compared.alignment.failures.map(({ code, step_id }) => [code, step_id]),
    ).toEqual(
      expect.arrayContaining([
        ["duplicate_before_step_id", "ambiguous-before"],
        ["duplicate_after_step_id", "ambiguous-after"],
        ["missing_before_step", "after-only"],
        ["missing_after_step", "before-only"],
      ]),
    );
    expect(compared.alignment.failures).toHaveLength(4);
    expect(compared.steps).toMatchObject([
      {
        step_id: "scenario_start",
        before_step_index: 0,
        after_step_index: 0,
        status: "unchanged",
      },
      {
        step_id: "keep-z",
        before_step_index: 1,
        after_step_index: 3,
        status: "unchanged",
      },
      {
        step_id: "keep-a",
        before_step_index: 3,
        after_step_index: 1,
        status: "unchanged",
      },
    ]);
  });

  it("rejects duplicate normalization rule IDs", () => {
    const capture = scenarioCapture({});
    expect(
      compareBrowserScenariosInputSchema.safeParse({
        before_scenario: capture,
        after_scenario: capture,
        normalization: {
          rules: [
            {
              rule_id: "volatile",
              artifacts: ["dom"],
              match: "one",
              replacement: "[VALUE]",
            },
            {
              rule_id: "volatile",
              artifacts: ["url"],
              match: "two",
              replacement: "[VALUE]",
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
});

const multiStepScenarioCapture = (
  actionCount: number,
  content: string,
): BrowserScenarioCapture => {
  const capture = scenarioCapture({});
  const template = capture.steps[1];
  if (template === undefined) throw new Error("Expected scenario action step");
  const steps = [
    capture.steps[0],
    ...Array.from({ length: actionCount }, (_, index) => ({
      ...template,
      step_index: index + 1,
      step_id: `step-${String(index + 1)}`,
      event_sequence_start: index + 1,
      event_sequence_end: index + 1,
      artifacts: {
        ...template.artifacts,
        dom: {
          state: "captured" as const,
          value: textArtifact(`${content}-${String(index + 1)}`),
        },
      },
    })),
  ];
  return browserScenarioCaptureSchema.parse({
    ...capture,
    scenario: { ...capture.scenario, action_count: actionCount },
    steps,
  });
};

describe("storage fingerprint provenance", () => {
  const withStorage = (value: unknown) => {
    const base = scenarioCapture({});
    return browserScenarioCaptureSchema.parse({
      ...base,
      steps: base.steps.map((step) => ({
        ...step,
        artifacts: {
          ...step.artifacts,
          storage: { state: "captured", value },
        },
      })),
    });
  };
  const compare = (before: unknown, after: unknown) =>
    compareBrowserScenarios(
      compareBrowserScenariosInputSchema.parse({
        before_scenario: withStorage(before),
        after_scenario: withStorage(after),
      }),
    );
  const empty = { cookies: [], local_storage: [], session_storage: [] };

  it.each(["cookies", "local_storage", "session_storage"])(
    "withholds legacy %s value identity on either side",
    (kind) => {
      const entry = {
        name: "value",
        value_state: "hashed",
        value_sha256: "a".repeat(64),
      };
      const value = {
        ...empty,
        [kind]: [
          kind === "cookies"
            ? {
                ...entry,
                domain: "app.example.test",
                path: "/",
                secure: false,
                http_only: false,
                same_site: "Lax",
              }
            : entry,
        ],
      };
      const current = { ...value, fingerprint_version: 2 };
      for (const [before, after] of [
        [value, value],
        [value, current],
        [current, value],
      ]) {
        const result = compare(before, after);
        expect(result.overall_status).toBe("unknown");
        expect(result.steps.flatMap((step) => step.artifact_diffs)).toEqual([
          expect.objectContaining({
            artifact: "storage",
            status: "unknown",
            reason: expect.stringContaining("Legacy storage fingerprints"),
          }),
          expect.objectContaining({
            artifact: "storage",
            status: "unknown",
            reason: expect.stringContaining("Legacy storage fingerprints"),
          }),
        ]);
      }
      expect(compare(current, current).overall_status).toBe("unchanged");
    },
  );

  it("conservatively withholds legacy comparisons even when digests differ", () => {
    const entry = {
      name: "value",
      value_state: "hashed",
      value_sha256: "a".repeat(64),
    };
    const left = { ...empty, local_storage: [entry] };
    const right = {
      ...empty,
      local_storage: [{ ...entry, value_sha256: "b".repeat(64) }],
    };
    for (const [before, after] of [
      [left, right],
      [left, { ...right, fingerprint_version: 2 }],
      [{ ...left, fingerprint_version: 2 }, right],
    ])
      expect(compare(before, after).overall_status).toBe("unknown");
  });

  it("checks legacy provenance before applying storage normalization", () => {
    const legacy = {
      ...empty,
      local_storage: [
        {
          name: "value",
          value_state: "hashed",
          value_sha256: "a".repeat(64),
        },
      ],
    };
    const result = compareBrowserScenarios(
      compareBrowserScenariosInputSchema.parse({
        before_scenario: withStorage(legacy),
        after_scenario: withStorage({ ...legacy, fingerprint_version: 2 }),
        normalization: {
          rules: [
            {
              rule_id: "rewrite-value-state",
              artifacts: ["storage"],
              match: "hashed",
              replacement: "redacted-secret",
            },
          ],
        },
      }),
    );
    expect(result.overall_status).toBe("unknown");
    expect(result.steps.flatMap((step) => step.artifact_diffs)).toEqual([
      expect.objectContaining({
        artifact: "storage",
        status: "unknown",
        reason: expect.stringContaining("Legacy storage fingerprints"),
      }),
      expect.objectContaining({
        artifact: "storage",
        status: "unknown",
        reason: expect.stringContaining("Legacy storage fingerprints"),
      }),
    ]);
  });

  it.each([false, true])(
    "does not turn encoding metadata alone into a storage change (redacted=%s)",
    (redacted) => {
      const entries = redacted
        ? [
            {
              name: "secret",
              value_state: "redacted-secret",
              value_sha256: null,
            },
          ]
        : [];
      const legacy = { ...empty, local_storage: entries };
      const current = { ...legacy, fingerprint_version: 2 };
      expect(compare(legacy, current).overall_status).toBe("unchanged");
      expect(compare(current, legacy).overall_status).toBe("unchanged");
    },
  );
});

interface ScenarioCaptureOptions {
  readonly stepId?: string;
  readonly action?: string;
  readonly domText?: string;
  readonly elapsedMs?: number;
  readonly eventSequence?: number;
}

const scenarioCapture = (
  options: ScenarioCaptureOptions,
): BrowserScenarioCapture => {
  const url = {
    url: "https://app.example.test/settings",
    origin: "https://app.example.test",
    query_parameter_names: [],
    redacted: false,
  };
  const completeness = {
    status: "complete",
    equality_eligible: true,
    missing_sections: [],
    truncated_sections: [],
  };
  const artifacts = (text: string) => ({
    screenshot: { state: "not_requested" },
    dom: { state: "captured", value: textArtifact(text) },
    accessibility: { state: "not_requested" },
    url: { state: "captured", value: url },
    history: { state: "not_requested" },
    storage: { state: "not_requested" },
  });
  const eventSequence = options.eventSequence ?? 1;
  return browserScenarioCaptureSchema.parse({
    browser: {
      mode: "launch",
      process_ownership: "provider-owned",
      cleanup: "terminated-owned-process",
      product: "Chromium",
      version: "149.0",
    },
    scenario: {
      start_origin: "https://app.example.test",
      action_count: 1,
      secret_references: [],
      network_content: {
        request_body: false,
        response_body: false,
        header_values: false,
      },
      event_families: ["console"],
      limits: DEFAULT_BROWSER_SCENARIO_CAPTURE_LIMITS,
    },
    duration_ms: options.elapsedMs ?? 10,
    steps: [
      {
        step_index: 0,
        step_id: "scenario_start",
        action: "scenario_start",
        status: "completed",
        elapsed_ms: 0,
        before_url: url,
        after_url: url,
        error: null,
        event_sequence_start: 1,
        event_sequence_end: 0,
        artifacts: artifacts("<main>Ready</main>"),
        completeness,
      },
      {
        step_index: 1,
        step_id: options.stepId ?? "open-settings",
        action: options.action ?? "click",
        status: "completed",
        elapsed_ms: options.elapsedMs ?? 10,
        before_url: url,
        after_url: url,
        error: null,
        event_sequence_start: eventSequence,
        event_sequence_end: eventSequence,
        artifacts: artifacts(options.domText ?? "<main>Settings</main>"),
        completeness,
      },
    ],
    events: {
      retained: 1,
      dropped: 0,
      items: [
        {
          sequence: eventSequence,
          step_index: 1,
          kind: "console",
          level: "info",
          text: "settings-ready",
          url: null,
        },
      ],
      omissions: noEventOmissions,
    },
    completeness,
    limitations: [],
  });
};

const textArtifact = (text: string) => {
  const bytes = Buffer.from(text);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
    text,
  };
};

const storageScenarioCapture = (
  family: "cookies" | "local_storage" | "session_storage",
  entries: readonly { name: string; value_sha256: string }[],
): BrowserScenarioCapture => {
  const capture = scenarioCapture({});
  const values = entries.map((entry) => ({
    ...(family === "cookies"
      ? {
          domain: "app.example.test",
          path: "/",
          secure: true,
          http_only: false,
          same_site: "Lax",
        }
      : {}),
    ...entry,
    value_state: "hashed",
  }));
  return browserScenarioCaptureSchema.parse({
    ...capture,
    steps: capture.steps.map((step) => ({
      ...step,
      artifacts: {
        ...step.artifacts,
        storage: {
          state: "captured",
          value: {
            fingerprint_version: BROWSER_STORAGE_FINGERPRINT_VERSION,
            cookies: [],
            local_storage: [],
            session_storage: [],
            [family]: values,
          },
        },
      },
    })),
  });
};

it.each(["cookies", "local_storage", "session_storage"] as const)(
  "compares %s contents independently of enumeration order without losing edits or multiplicity",
  (family) => {
    const entries = [
      { name: "theme", value_sha256: "a".repeat(64) },
      { name: "locale", value_sha256: "b".repeat(64) },
    ] as const;
    const before = storageScenarioCapture(family, entries);
    const after = storageScenarioCapture(family, entries.toReversed());
    const retained = structuredClone(after);
    const compare = (right: BrowserScenarioCapture) =>
      compareBrowserScenarios(
        compareBrowserScenariosInputSchema.parse({
          before_scenario: before,
          after_scenario: right,
        }),
      );
    expect(compare(after).overall_status).toBe("unchanged");
    expect(compare(after).normalization.built_in_rules).toContain(
      "compare_storage_entries_as_unordered_collection",
    );
    expect(after).toEqual(retained);
    const normalized = compareBrowserScenarios(
      compareBrowserScenariosInputSchema.parse({
        before_scenario: before,
        after_scenario: after,
        normalization: {
          rules: [
            {
              rule_id: "names",
              artifacts: ["storage"],
              match: "theme",
              replacement: "locale",
            },
          ],
        },
      }),
    );
    expect(normalized.overall_status).toBe("unchanged");
    for (const changed of [
      [{ ...entries[0], value_sha256: "c".repeat(64) }, entries[1]],
      [entries[0]],
      [...entries, entries[0]],
    ]) {
      const result = compare(storageScenarioCapture(family, changed));
      expect(result.overall_status).toBe("changed");
      expect(result.steps[0]?.artifact_diffs).toContainEqual(
        expect.objectContaining({ artifact: "storage", status: "changed" }),
      );
    }
  },
);

it("retains cookie scope and flags when canonicalizing storage inventories", () => {
  const before = storageScenarioCapture("cookies", [
    { name: "session", value_sha256: "a".repeat(64) },
  ]);
  for (const change of [
    { path: "/profile" },
    { domain: ".example.test" },
    { secure: false },
    { http_only: true },
    { same_site: "Strict" },
  ]) {
    const after = structuredClone(before);
    const storage = after.steps[0]?.artifacts.storage;
    if (storage?.state !== "captured" || storage.value.cookies[0] === undefined)
      throw new Error("Expected captured cookie fixture");
    Object.assign(storage.value.cookies[0], change);
    expect(
      compareBrowserScenarios(
        compareBrowserScenariosInputSchema.parse({
          before_scenario: before,
          after_scenario: after,
        }),
      ).overall_status,
    ).toBe("changed");
  }
});
