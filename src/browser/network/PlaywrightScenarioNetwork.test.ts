import { afterEach, expect, it, vi } from "vitest";

import { browserScenarioSchema } from "../../domain/browserScenario.js";
import {
  browserScenarioEventSchema,
  type BrowserScenarioEvent,
} from "../../domain/browserScenarioCaptureValues.js";
import type { BrowserNetworkContentSelection } from "../../domain/browserNetworkEvidence.js";
import { resolveScenarioSecrets } from "../../../tests/fixtures/browserScenarioSecrets.js";
import {
  PlaywrightScenarioNetwork,
  type ScenarioNetworkRequest,
  type ScenarioNetworkResponse,
} from "./PlaywrightScenarioNetwork.js";

class RequestFixture implements ScenarioNetworkRequest {
  headerReads = 0;
  bodyReads = 0;
  predecessor: ScenarioNetworkRequest | null = null;
  responseSize = 64;
  constructor(readonly marker: string) {}
  method() {
    return "POST";
  }
  url() {
    return "https://example.test/same-url";
  }
  resourceType() {
    return "fetch";
  }
  async sizes() {
    return { responseBodySize: this.responseSize };
  }
  headers(): Record<string, string> {
    return {
      "content-type": "text/plain",
      authorization: "Bearer private-transport",
    };
  }
  async headersArray() {
    this.headerReads += 1;
    return Object.entries(this.headers()).map(([name, value]) => ({
      name,
      value,
    }));
  }
  postDataBuffer(): Buffer | null {
    this.bodyReads += 1;
    return Buffer.from(this.marker);
  }
  redirectedFrom() {
    return this.predecessor;
  }
  failure() {
    return { errorText: "connection reset" };
  }
}

class ResponseFixture implements ScenarioNetworkResponse {
  bodyReads = 0;
  headerReads = 0;
  read: () => Promise<Buffer>;
  constructor(
    private readonly source: ScenarioNetworkRequest,
    marker: string,
  ) {
    this.read = async () => Buffer.from(marker);
  }
  request() {
    return this.source;
  }
  url() {
    return this.source.url();
  }
  status() {
    return 200;
  }
  headers(): Record<string, string> {
    return {
      "content-type": "application/octet-stream",
      "set-cookie": "session=transport-secret",
    };
  }
  async headersArray() {
    this.headerReads += 1;
    return [
      { name: "X-Repeat", value: "first" },
      { name: "X-Repeat", value: "second" },
      { name: "Set-Cookie", value: "session=transport-secret" },
    ];
  }
  body() {
    this.bodyReads += 1;
    return this.read();
  }
}

const selection = {
  request_body: true,
  response_body: true,
  header_values: true,
};
const harness = (
  selected: BrowserNetworkContentSelection = selection,
  signal?: AbortSignal,
  secretValue = "私密",
  limitsInput: unknown = {},
) => {
  const scenario = browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: "/fixture/chrome" },
    start_url: { url: "https://example.test" },
    actions: [{ step_id: "done", action: "wait_for_timeout", duration_ms: 1 }],
    secrets: [
      { secret_id: "declared", environment_variable: "FIXTURE_SECRET" },
    ],
    capture: { limits: limitsInput },
  });
  const secrets = resolveScenarioSecrets(scenario, {
    FIXTURE_SECRET: secretValue,
  });
  const events: BrowserScenarioEvent[] = [];
  const omittedEventCounts = new Map<string, number>();
  const collector = new PlaywrightScenarioNetwork({
    selection: selected,
    limits: scenario.capture.limits,
    secrets,
    ...(signal === undefined ? {} : { signal }),
    emit: (event) => {
      const sequence = events.length + 1;
      events.push(
        browserScenarioEventSchema.parse({ ...event, sequence, step_index: 0 }),
      );
      return { status: "retained", sequence };
    },
    admitText: () => ({ status: "retained", sequence: events.length + 1 }),
    admitContentBody: () => ({
      status: "retained",
      sequence: events.length + 1,
    }),
    omitNetwork: (transactionId, kind, reason) => {
      let omission = networkOmissions.get(transactionId);
      if (omission === undefined) {
        omission = { kinds: new Set(), reasons: new Set() };
        networkOmissions.set(transactionId, omission);
      }
      omission.kinds.add(kind);
      omission.reasons.add(reason);
    },
    omitEvent: (kind) => {
      omittedEventCounts.set(kind, (omittedEventCounts.get(kind) ?? 0) + 1);
    },
  });
  const networkOmissions = new Map<
    string,
    { kinds: Set<string>; reasons: Set<string> }
  >();
  return {
    collector,
    events,
    limits: scenario.capture.limits,
    secrets,
    networkOmissions,
    omittedEventCounts,
  };
};

const bodyText = (event: BrowserScenarioEvent) => {
  if (event.kind !== "network-content" || event.body.state !== "captured")
    throw new Error("Expected retained network bytes");
  return Buffer.from(event.body.content, "base64").toString();
};

afterEach(() => vi.useRealTimers());

it.each([true, false])(
  "protects source body and headers before the binding is saved (body selected: %s)",
  async (responseBody) => {
    const { collector, events, secrets } = harness({
      request_body: false,
      response_body: responseBody,
      header_values: true,
    });
    const request = new RequestFixture("marked");
    const secret = "source-token-729d";
    const response = new ResponseFixture(
      request,
      JSON.stringify({ token: secret, public: "kept" }),
    );
    vi.spyOn(response, "headers").mockReturnValue({
      "content-type": "application/json",
      "x-derived-token": secret,
    });
    vi.spyOn(response, "headersArray").mockResolvedValue([
      { name: "X-Derived-Token", value: secret },
    ]);
    secrets.responseProtector("login", [
      { name: "token", json_pointer: "/token", secret: true },
    ])?.(request);
    collector.request(request);
    collector.response(response);
    collector.finished(request);
    await collector.finish();
    const content = events.find(
      (event) => event.kind === "network-content" && event.phase === "response",
    );
    if (content?.kind !== "network-content")
      throw new Error("Missing response content");
    expect(JSON.stringify(content.headers)).not.toContain(secret);
    expect(content.headers.state).toBe("captured");
    if (responseBody)
      expect(JSON.parse(bodyText(content))).toEqual({
        token: "[REDACTED:page:login.token]",
        public: "kept",
      });
    else expect(content.body.state).toBe("not_requested");
    expect(() => secrets.savedValue("token")).toThrow("No earlier step saved");
    secrets.save("login.token", "token", secret, true);
    expect(secrets.redact(secret)).toBe("[REDACTED:page:login.token]");
    expect(response.bodyReads).toBe(1);
  },
);

it.each([
  ['{"token":"\\u0073ecret-token"}', "/token"],
  ['{"token":"secret\\/token"}', "/token"],
  ['{"token":1e3}', "/token"],
  ['{"token":1000.0}', "/token"],
  ['{"items":[{"a/b":"\\u0073ecret-token"}]}', "/items/0/a~1b"],
  ['{"token":"shadowed","token":"\\u0073ecret-token"}', "/token"],
])(
  "redacts the selected source JSON token structurally: %s",
  async (body, pointer) => {
    const { collector, events, secrets } = harness({
      request_body: false,
      response_body: true,
      header_values: false,
    });
    const request = new RequestFixture("marked");
    request.responseSize = Buffer.byteLength(body);
    secrets.responseProtector("login", [
      { name: "token", json_pointer: pointer, secret: true },
    ])?.(request);
    collector.request(request);
    collector.response(new ResponseFixture(request, body));
    collector.finished(request);
    await collector.finish();
    const content = events.find(
      (event) => event.kind === "network-content" && event.phase === "response",
    );
    expect(content).toBeDefined();
    const text = bodyText(content!);
    expect(text).not.toMatch(/secret|0073|shadowed|1e3|1000/u);
    expect(JSON.parse(text)).toBeDefined();
    expect(text).toContain("[REDACTED:page:login.token]");
  },
);

it.each([
  { size: 20, headers: { "content-encoding": "gzip" } },
  {
    size: 0,
    headers: { "content-encoding": "gzip", "content-length": "0024" },
  },
])(
  "reads and redacts marked content within its decoded bound: %j",
  async (bounds) => {
    const { collector, events, secrets } = harness({
      request_body: false,
      response_body: true,
      header_values: false,
    });
    const request = new RequestFixture("marked");
    const body = '{"token":"secret-token"}';
    request.responseSize = bounds.size;
    const response = new ResponseFixture(request, body);
    vi.spyOn(response, "headers").mockReturnValue({
      "content-type": "application/json",
      ...bounds.headers,
    });
    secrets.responseProtector("login", [
      { name: "token", json_pointer: "/token", secret: true },
    ])?.(request);
    collector.request(request);
    collector.response(response);
    collector.finished(request);
    await collector.finish();
    const content = events.find(
      (event) => event.kind === "network-content" && event.phase === "response",
    );
    expect(content).toBeDefined();
    const text = bodyText(content!);
    expect(text).not.toContain("secret-token");
    expect(text).toContain("[REDACTED:page:login.token]");
    expect(response.bodyReads).toBe(1);
  },
);

it("preserves unselected source spellings while redacting escaped aliases", async () => {
  const { collector, events, secrets } = harness({
    request_body: false,
    response_body: true,
    header_values: false,
  });
  const request = new RequestFixture("marked");
  const body =
    '{ "token":"secret-token", "mirror":"\\u0073ecret-token", "unknown":1e-400 }';
  request.responseSize = Buffer.byteLength(body);
  secrets.responseProtector("login", [
    { name: "token", json_pointer: "/token", secret: true },
  ])?.(request);
  collector.request(request);
  collector.response(new ResponseFixture(request, body));
  collector.finished(request);
  await collector.finish();
  const content = events.find(
    (event) => event.kind === "network-content" && event.phase === "response",
  );
  const text = bodyText(content!);
  expect(text).toContain('"unknown":1e-400');
  expect(text).toContain('{ "token":');
  expect(text).not.toMatch(/secret|0073/u);
  expect(JSON.parse(text).mirror).toBe("[REDACTED:page:login.token]");
});

it("associates sensitive fields by request identity while keeping same-URL unmarked values", async () => {
  const { collector, events, secrets } = harness({
    request_body: false,
    response_body: true,
    header_values: false,
  });
  const marked = new RequestFixture("marked");
  const unmarked = new RequestFixture("unmarked");
  secrets.responseProtector("login", [
    { name: "token", json_pointer: "/token", secret: true },
  ])?.(marked);
  for (const [request, token] of [
    [marked, "private-token-729d"],
    [unmarked, "public-unmarked-token"],
  ] as const) {
    collector.request(request);
    collector.response(new ResponseFixture(request, JSON.stringify({ token })));
    collector.finished(request);
  }
  await collector.finish();
  const bodies = events
    .filter(
      (event) => event.kind === "network-content" && event.phase === "response",
    )
    .map((event) => JSON.parse(bodyText(event)));
  expect(bodies).toEqual(
    expect.arrayContaining([
      { token: "[REDACTED:page:login.token]" },
      { token: "public-unmarked-token" },
    ]),
  );
});

it.each([
  { size: 64, headers: { "content-encoding": "br" } },
  { size: 0, headers: { "content-length": "00012000001" } },
])(
  "withholds marked response content when decoded bounds are unknown or over budget: %j",
  async (bounds) => {
    const { collector, events, secrets } = harness();
    const request = new RequestFixture("marked");
    request.responseSize = bounds.size;
    const secret = "private-source-token";
    const response = new ResponseFixture(
      request,
      JSON.stringify({ token: secret }),
    );
    vi.spyOn(response, "headers").mockReturnValue({
      "content-type": "application/json",
      ...bounds.headers,
    });
    secrets.responseProtector("login", [
      { name: "token", json_pointer: "/token", secret: true },
    ])?.(request);
    collector.request(request);
    collector.response(response);
    collector.finished(request);
    await collector.finish();
    const content = events.find(
      (event) => event.kind === "network-content" && event.phase === "response",
    );
    if (content?.kind !== "network-content")
      throw new Error("Missing response content");
    expect(content.body.state).toBe("unavailable");
    expect(content.headers.state).toBe("unavailable");
    expect(response.bodyReads).toBe(0);
    expect(response.headerReads).toBe(0);
    expect(JSON.stringify(events)).not.toContain(secret);
  },
);

it("records phase omissions without reading blocked content or misreporting completion", async () => {
  const { limits, secrets } = harness();
  const reason = "max-total-event-allocation-bytes";
  let omit = true;
  const emit = vi.fn(() => ({ status: "retained", sequence: 1 }) as const);
  const omitNetwork = vi.fn();
  const redact = vi.spyOn(secrets, "redact");
  const collector = new PlaywrightScenarioNetwork({
    selection,
    limits,
    secrets,
    admitText: () =>
      omit
        ? { status: "omitted", sequence: 1, reason }
        : { status: "retained", sequence: 1 },
    emit,
    admitContentBody: () => ({ status: "retained", sequence: 1 }),
    omitNetwork,
    omitEvent: () => undefined,
  });
  const blocked = new RequestFixture("blocked");
  collector.request(blocked);
  expect(redact).not.toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalled();

  omit = false;
  const completed = new RequestFixture("admitted");
  const response = new ResponseFixture(completed, "body");
  collector.request(completed);
  collector.response(response);
  omit = true;
  collector.finished(completed);
  await collector.finish();

  expect(blocked.bodyReads + blocked.headerReads + response.bodyReads).toBe(0);
  expect(omitNetwork.mock.calls).toEqual([
    ["request-1", "request", reason],
    ["request-2", "request-finished", reason],
    ["request-1", "request-unfinished", reason],
  ]);
  expect(collector.limitations().join(" ")).toContain(
    "network coverage is incomplete",
  );
});

it("redacts declared secrets in browser-produced form and JSON encodings", async () => {
  for (const secret of ["私密", 'space " and \n']) {
    const { collector, events } = harness(selection, undefined, secret);
    const encoded = new RequestFixture(
      `value=${new URLSearchParams([["value", secret]]).toString().slice(6)}`,
    );
    const json = new RequestFixture(JSON.stringify({ value: secret }));
    collector.request(encoded);
    collector.request(json);
    await collector.finish();
    const content = events.filter(
      (event) => event.kind === "network-content" && event.phase === "request",
    );
    expect(content.map(bodyText)).toEqual([
      "value=[REDACTED:declared]",
      '{"value":"[REDACTED:declared]"}',
    ]);
  }
});

it("binds out-of-order same-URL content to its originating event", async () => {
  const { collector, events } = harness();
  const slow = new RequestFixture("slow");
  const fast = new RequestFixture("fast");
  const slowResponse = new ResponseFixture(slow, "reply:slow");
  const fastResponse = new ResponseFixture(fast, "reply:fast");
  slowResponse.status = () => 201;
  fastResponse.status = () => 202;
  collector.request(slow);
  collector.request(fast);
  collector.response(fastResponse);
  collector.response(slowResponse);
  collector.finished(fast);
  collector.finished(slow);
  await collector.finish();

  const content = events.filter((event) => event.kind === "network-content");
  const starts = events.filter((event) => event.kind === "request");
  expect(content).toHaveLength(4);
  expect(starts).toHaveLength(2);
  for (const [index, marker, status] of [
    [0, "slow", 201],
    [1, "fast", 202],
  ] as const) {
    const start = starts[index]!;
    const request = content.find(
      (event) => event.phase === "request" && bodyText(event) === marker,
    );
    const response = content.find(
      (event) =>
        event.phase === "response" && bodyText(event) === `reply:${marker}`,
    );
    expect(request).toMatchObject({
      transaction_id: start.transaction_id,
      source_event_sequence: start.sequence,
    });
    const reported = events.find(
      (event) => event.kind === "response" && event.status === status,
    );
    expect(reported).toMatchObject({ transaction_id: start.transaction_id });
    expect(response).toMatchObject({
      transaction_id: start.transaction_id,
      source_event_sequence: reported?.sequence,
      body: { representation: "playwright-response-body-bytes" },
    });
  }
});

it("records completed and unfinished metadata without reading content", async () => {
  const { collector, events } = harness({
    request_body: false,
    response_body: false,
    header_values: false,
  });
  const completed = new RequestFixture("complete");
  const response = new ResponseFixture(completed, "reply");
  const unfinished = new RequestFixture("pending");
  collector.request(completed);
  collector.response(response);
  collector.finished(completed);
  collector.request(unfinished);
  await collector.finish();

  for (const source of [completed, response, unfinished]) {
    expect(source.bodyReads).toBe(0);
    expect(source.headerReads).toBe(0);
  }
  expect(events.map(({ kind }) => kind)).toEqual([
    "request",
    "response",
    "request-finished",
    "request",
    "request-unfinished",
  ]);
  expect(collector.limitations()).toHaveLength(1);
  expect(JSON.stringify(events)).not.toContain("private-transport");
});

it.each([
  {
    selection: {
      request_body: true,
      response_body: false,
      header_values: false,
    },
    reads: [1, 1, 0, 0],
    phases: ["request"],
  },
  {
    selection: {
      request_body: false,
      response_body: true,
      header_values: false,
    },
    reads: [0, 0, 1, 1],
    phases: ["response"],
  },
  {
    selection: {
      request_body: false,
      response_body: false,
      header_values: true,
    },
    reads: [0, 1, 0, 1],
    phases: ["request", "response"],
  },
])(
  "reads selected bodies and the headers needed for their type $selection",
  async ({ selection: selected, reads, phases }) => {
    const { collector, events } = harness(selected);
    const request = new RequestFixture("input");
    const response = new ResponseFixture(request, "output");
    collector.request(request);
    collector.response(response);
    collector.finished(request);
    await collector.finish();
    expect([
      request.bodyReads,
      request.headerReads,
      response.bodyReads,
      response.headerReads,
    ]).toEqual(reads);
    expect(
      events
        .filter((event) => event.kind === "network-content")
        .map((event) => event.phase),
    ).toEqual(phases);
    if (!selected.header_values)
      expect(
        events
          .filter((event) => event.kind === "network-content")
          .map(({ headers }) => headers),
      ).toEqual([{ state: "not_requested" }]);
  },
);

it("preserves duplicate headers and binary bytes, redacting credentials and declared UTF-8 secrets", async () => {
  const { collector, events } = harness();
  const request = new RequestFixture("input");
  const response = new ResponseFixture(request, "unused");
  response.read = async () =>
    Buffer.concat([
      Buffer.from([0xff, 0x00]),
      Buffer.from("私密"),
      Buffer.from([0xfe]),
    ]);
  collector.request(request);
  collector.response(response);
  expect(response.bodyReads).toBe(0);
  collector.finished(request);
  await collector.finish();
  const content = events.find(
    (event) => event.kind === "network-content" && event.phase === "response",
  );
  if (content?.kind !== "network-content" || content.body.state !== "captured")
    throw new Error("Missing response");
  expect(
    Buffer.compare(
      Buffer.from(content.body.content, "base64"),
      Buffer.concat([
        Buffer.from([0xff, 0x00]),
        Buffer.from("[REDACTED:declared]"),
        Buffer.from([0xfe]),
      ]),
    ),
  ).toBe(0);
  expect(content.body.redacted).toBe(true);
  expect(content.headers).toEqual({
    state: "captured",
    items: [
      { name: "X-Repeat", value: "first", redacted: false },
      { name: "X-Repeat", value: "second", redacted: false },
      { name: "Set-Cookie", value: null, redacted: true },
    ],
  });
  expect(JSON.stringify(events)).not.toContain("transport-secret");
});

it("does not read unfinished streaming responses and reports the cutoff", async () => {
  const { collector, events } = harness();
  const request = new RequestFixture("stream");
  const response = new ResponseFixture(request, "never-complete");
  collector.request(request);
  collector.response(response);
  await collector.finish();
  expect(response.bodyReads).toBe(0);
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "request-unfinished",
      reason: "capture-ended",
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "network-content",
      phase: "response",
      body: expect.objectContaining({
        state: "unavailable",
        reason: "response-unfinished",
      }),
    }),
  );
  expect(collector.limitations().length).toBeGreaterThan(0);
});

it.each(["completion", "cancellation"])(
  "keeps completed response reads bounded through %s",
  async (terminal) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { collector, events } = harness(
      { request_body: false, response_body: true, header_values: false },
      controller.signal,
    );
    const markers = Array.from({ length: 20 }, (_, index) => `queued-${index}`);
    const responses = markers.map((marker) => {
      const request = new RequestFixture(marker);
      const response = new ResponseFixture(request, "unused");
      response.read = () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(Buffer.from(marker)), 4_000);
        });
      collector.request(request);
      collector.response(response);
      collector.finished(request);
      return response;
    });
    const content = () =>
      events.filter(
        (event) =>
          event.kind === "network-content" && event.phase === "response",
      );
    const firstBatch = [...Array<number>(16).fill(1), 0, 0, 0, 0];
    const finishing = collector.finish();
    try {
      expect(responses.map(({ bodyReads }) => bodyReads)).toEqual(firstBatch);
      if (terminal === "cancellation") {
        controller.abort();
        await vi.advanceTimersByTimeAsync(0);
        expect(responses.map(({ bodyReads }) => bodyReads)).toEqual(firstBatch);
        expect(content()).toEqual(
          Array.from({ length: responses.length }, () =>
            expect.objectContaining({
              body: expect.objectContaining({
                state: "unavailable",
                reason: "cancelled",
              }),
            }),
          ),
        );
      } else {
        await vi.advanceTimersByTimeAsync(4_000);
        expect(content().map(bodyText).sort()).toEqual(
          markers.slice(0, 16).sort(),
        );
        await vi.advanceTimersByTimeAsync(4_000);
        expect(content().map(bodyText).sort()).toEqual([...markers].sort());
        expect(responses.map(({ bodyReads }) => bodyReads)).toEqual(
          Array<number>(responses.length).fill(1),
        );
      }
      await finishing;
    } finally {
      controller.abort();
      await vi.runAllTimersAsync();
      await finishing;
    }
  },
);

it("bounds hung completed-body reads and rejects late mutation after finalization", async () => {
  vi.useFakeTimers();
  const { collector, events } = harness();
  const request = new RequestFixture("hung");
  const response = new ResponseFixture(request, "unused");
  let release: (bytes: Buffer) => void = () => {
    throw new Error("Read was not started");
  };
  response.read = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  collector.request(request);
  collector.response(response);
  collector.finished(request);
  const finishing = collector.finish();
  await vi.advanceTimersByTimeAsync(5_001);
  await finishing;
  const frozen = JSON.stringify(events);
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "network-content",
      phase: "response",
      body: expect.objectContaining({
        state: "unavailable",
        reason: "body-read-timeout",
      }),
    }),
  );
  release(Buffer.from("late"));
  collector.request(new RequestFixture("after-cutoff"));
  await Promise.resolve();
  expect(JSON.stringify(events)).toBe(frozen);
});

it.each([false, true])(
  "records failed requests without hiding header read gaps (headers fail: %s)",
  async (headersFail) => {
    const { collector, events } = harness();
    const request = new RequestFixture("failed");
    const response = new ResponseFixture(request, "partial");
    if (headersFail)
      vi.spyOn(response, "headersArray").mockRejectedValue(
        new Error("Headers unavailable"),
      );
    collector.request(request);
    collector.response(response);
    collector.failed(request);
    await collector.finish();
    expect(response.bodyReads).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "request-failed",
        failure: "connection reset",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "network-content",
        phase: "response",
        body: expect.objectContaining({ reason: "request-failed" }),
      }),
    );
    expect(collector.limitations()).toHaveLength(headersFail ? 1 : 0);
  },
);

it("links observed redirect hops and leaves unseen predecessors unknown", async () => {
  const { collector, events } = harness();
  const first = new RequestFixture("first");
  const next = new RequestFixture("next");
  next.predecessor = first;
  const unseen = new RequestFixture("unseen");
  unseen.predecessor = new RequestFixture("outside-capture");
  collector.request(first);
  collector.request(next);
  collector.request(unseen);
  await collector.finish();
  const requests = events.filter((event) => event.kind === "request");
  expect(requests[0]?.redirected_from_transaction_state).toBe("root");
  expect(requests[1]?.redirected_from_transaction_id).toBe(
    requests[0]?.transaction_id,
  );
  expect(requests[1]?.redirected_from_transaction_state).toBeUndefined();
  expect(requests[2]?.redirected_from_transaction_id).toBeNull();
  expect(requests[2]?.redirected_from_transaction_state).toBe("unknown");
});

it("preserves read errors and does not turn unexposed or empty bytes into the same state", async () => {
  const { collector, events } = harness();
  const missing = new RequestFixture("missing");
  missing.postDataBuffer = () => null;
  const response = new ResponseFixture(missing, "unused");
  response.read = async () => {
    throw new Error("Cannot read 私密 response");
  };
  response.headersArray = async () => {
    throw new Error("Headers unavailable 私密");
  };
  const empty = new RequestFixture("");
  collector.request(missing);
  collector.response(response);
  collector.finished(missing);
  const emptyResponse = new ResponseFixture(empty, "");
  emptyResponse.headersArray = async () => [
    { name: "Content-Type", value: "application/json" },
  ];
  collector.request(empty);
  collector.response(emptyResponse);
  collector.finished(empty);
  await collector.finish();
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "network-content",
      phase: "request",
      body: { state: "not_exposed" },
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "network-content",
      phase: "response",
      headers: {
        state: "unavailable",
        message: "Headers unavailable [REDACTED:declared]",
      },
      body: {
        state: "unavailable",
        reason: "body-read-failed",
        message: "Cannot read [REDACTED:declared] response",
      },
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "network-content",
      phase: "response",
      body: expect.objectContaining({
        state: "captured",
        content: "",
        bytes: 0,
        media_type: "application/json",
        media_type_source: "content-type-header",
      }),
    }),
  );
  expect(collector.limitations().length).toBeGreaterThan(0);
});

const quotedJsonType = 'application/json; note="one,two"';

it.each([
  {
    label: "conflicting declarations",
    declarations: ["application/json", "application/octet-stream"],
    type: null,
  },
  {
    label: "a coalesced declaration",
    declarations: ["application/json; charset=utf-8, application/octet-stream"],
    type: null,
  },
  {
    label: "agreeing declarations with a quoted comma",
    declarations: [quotedJsonType, quotedJsonType],
    type: quotedJsonType,
  },
  { label: "unreadable headers", declarations: null, type: null },
  {
    label: "a redacted declaration",
    declarations: ["application/json; fixture=%E7%A7%81%E5%AF%86"],
    type: null,
    retainedHeader: "application/json; fixture=[REDACTED:declared]",
  },
])(
  "derives safe body media evidence from $label",
  async ({ declarations, type, retainedHeader }) => {
    const { collector, events } = harness({
      request_body: false,
      response_body: true,
      header_values: retainedHeader !== undefined,
    });
    const request = new RequestFixture("input");
    const response = new ResponseFixture(request, '{"value":"\\u79c1\\u5bc6"}');
    // The flattened metadata cannot establish the producer's ordered Content-Type.
    response.headers = () => ({ "content-type": "application/octet-stream" });
    response.headersArray = async () => {
      response.headerReads += 1;
      if (declarations === null) throw new Error("Headers unavailable");
      return declarations.map((value) => ({ name: "Content-Type", value }));
    };
    collector.request(request);
    collector.response(response);
    collector.finished(request);
    await collector.finish();
    const content = events.find(
      (event) => event.kind === "network-content" && event.phase === "response",
    );
    expect(response.headerReads).toBe(1);
    expect(content).toMatchObject({
      headers:
        retainedHeader === undefined
          ? { state: "not_requested" }
          : {
              state: "captured",
              items: [
                { name: "Content-Type", value: retainedHeader, redacted: true },
              ],
            },
      body: {
        state: "captured",
        media_type: type,
        media_type_source: "content-type-header",
      },
    });
    if (content === undefined) throw new Error("Missing response content");
    expect(JSON.parse(bodyText(content))).toEqual({
      value: "[REDACTED:declared]",
    });
  },
);

it.each([
  {
    label: "default",
    cap: 1024,
    selected: selection,
    limits: {},
  },
  {
    label: "caller-selected",
    cap: 2,
    selected: {
      request_body: false,
      response_body: true,
      header_values: false,
    },
    limits: { max_network_transactions: 2 },
  },
])(
  "enforces the $label transaction limit before reading content and counts omissions once",
  async ({ cap, selected, limits }) => {
    const { collector, events, omittedEventCounts } = harness(
      selected,
      undefined,
      "fixture",
      limits,
    );
    const admitted = Array.from({ length: cap }, (_, index) => {
      const request = new RequestFixture(`body-${index}`);
      collector.request(request);
      collector.request(request);
      return request;
    });
    const omitted = ["finished", "failed", "pending"].map((state) => {
      const request = new RequestFixture(state);
      const response = new ResponseFixture(request, state);
      collector.request(request);
      collector.request(request);
      collector.response(response);
      collector.response(response);
      return { request, response, state };
    });
    expect(omittedEventCounts.get("network-content")).toBe(
      selected.request_body ? 6 : 3,
    );
    for (const { request, state } of omitted) {
      if (state === "finished") collector.finished(request);
      if (state === "failed") collector.failed(request);
    }
    const admittedResponse = new ResponseFixture(admitted[0]!, "retained");
    collector.response(admittedResponse);
    collector.finished(admitted[0]!);
    await collector.finish();

    expect(events.filter(({ kind }) => kind === "request")).toHaveLength(cap);
    expect(
      events.filter(({ kind }) => kind === "network-content"),
    ).toHaveLength((selected.request_body ? cap : 0) + 1);
    const extraOrMissingReads = admitted.filter(
      ({ bodyReads, headerReads }) =>
        bodyReads !== Number(selected.request_body) ||
        headerReads !== Number(selected.header_values),
    );
    expect(extraOrMissingReads.map(({ marker }) => marker)).toEqual([]);
    expect(admittedResponse.bodyReads).toBe(1);
    for (const { request, response } of omitted) {
      expect(request.bodyReads + request.headerReads).toBe(0);
      expect(response.bodyReads + response.headerReads).toBe(0);
    }
    expect(collector.omittedTransactionRange()).toEqual({
      first_transaction_id: `request-${cap + 1}`,
      last_transaction_id: `request-${cap + 3}`,
      count: 3,
      reason: "max-network-transactions",
    });
    expect(Object.fromEntries(omittedEventCounts)).toEqual({
      request: 3,
      response: 3,
      "request-finished": 1,
      "request-failed": 1,
      "network-content": selected.request_body ? 6 : 3,
    });
    expect(collector.limitations().join(" ")).toContain("resource budget");
  },
);

it.each([
  { label: "default", limit: 64 * 1024, limits: {} },
  { label: "caller-selected", limit: 4, limits: { max_network_body_bytes: 4 } },
])(
  "reports the $label body-byte limit while retaining a body exactly at the limit",
  async ({ limit, limits }) => {
    const { collector, events } = harness(selection, undefined, "fixture", {
      ...limits,
      // Exercise the byte boundary independently of redaction allocation.
      max_network_body_allocation_bytes: 16 * 1024 * 1024,
    });
    const admitted = "x".repeat(limit);
    collector.request(new RequestFixture(admitted + "x"));
    collector.request(new RequestFixture(admitted));
    await collector.finish();
    const content = events.filter((event) => event.kind === "network-content");
    expect(content).toHaveLength(2);
    expect(
      content.find(({ transaction_id }) => transaction_id === "request-1"),
    ).toMatchObject({
      body: {
        state: "unavailable",
        reason: "body-size-limit",
        limit_bytes: limit,
        observed_bytes: limit + 1,
      },
    });
    const accepted = content.find(
      ({ transaction_id }) => transaction_id === "request-2",
    );
    if (accepted === undefined) throw new Error("Missing retained body");
    expect(bodyText(accepted)).toBe(admitted);
  },
);

it("keeps header names and selected body when unselected values are oversized", async () => {
  const { collector, events } = harness({
    request_body: true,
    response_body: false,
    header_values: false,
  });
  const request = new RequestFixture("retained body");
  request.headers = () => ({
    "x-large-unselected": "x".repeat(1024 * 1024 + 1),
  });
  collector.request(request);
  await collector.finish();

  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "request",
      header_names: ["x-large-unselected"],
    }),
  );
  expect(
    events.find((event) => event.kind === "network-content"),
  ).toMatchObject({
    phase: "request",
    headers: { state: "not_requested" },
    body: { state: "captured" },
  });
  expect(request.bodyReads).toBe(1);
});

it("reserves redaction expansion before creating replacement copies", async () => {
  const { collector, events, secrets } = harness(selection, undefined, "a");
  const redact = vi.spyOn(secrets, "redactBytes");
  collector.request(new RequestFixture("a".repeat(64 * 1024)));
  await collector.finish();
  expect(
    events.find((event) => event.kind === "network-content")?.body,
  ).toMatchObject({
    state: "unavailable",
    reason: "body-allocation-limit",
  });
  // Ordinary header values can still pass through the byte redactor.
  expect(redact.mock.calls.every(([value]) => value.length < 64 * 1024)).toBe(
    true,
  );
});

it("stamps when each request was observed, and the browser's own start and duration once it ends", async () => {
  vi.useFakeTimers({ now: Date.parse("2026-10-24T05:00:00.250Z") });
  const { collector, events } = harness({
    request_body: false,
    response_body: false,
    header_values: false,
  });
  class TimedRequest extends RequestFixture {
    constructor(
      marker: string,
      readonly startTime: number,
      readonly responseEnd: number,
    ) {
      super(marker);
    }
    timing() {
      return { startTime: this.startTime, responseEnd: this.responseEnd };
    }
  }
  const finished = new TimedRequest(
    "timed",
    Date.parse("2026-10-24T05:00:00.200Z"),
    12.5,
  );
  const failed = new TimedRequest("untimed", 0, -1);
  collector.request(finished);
  collector.request(failed);
  collector.finished(finished);
  collector.failed(failed);
  await collector.finish();
  expect(events.filter(({ kind }) => kind === "request")).toEqual([
    expect.objectContaining({ observed_at: "2026-10-24T05:00:00.250Z" }),
    expect.objectContaining({ observed_at: "2026-10-24T05:00:00.250Z" }),
  ]);
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "request-finished",
      started_at: "2026-10-24T05:00:00.200Z",
      elapsed_ms: 12.5,
    }),
  );
  const failure = events.find(({ kind }) => kind === "request-failed");
  expect(failure).toBeDefined();
  expect(failure).not.toHaveProperty("started_at");
  expect(failure).not.toHaveProperty("elapsed_ms");
});

it.each([
  { name: "structural expansion", body: '{"token":1}', limit: 16 },
  {
    name: "shadowed container",
    body: '{"token":{},"token":"source-private"}',
    limit: 2048,
  },
])("withholds marked content for $name", async ({ body, limit }) => {
  const { collector, events, secrets } = harness(
    selection,
    undefined,
    "declared-private",
    { max_network_body_bytes: limit },
  );
  const request = new RequestFixture("marked");
  request.responseSize = Buffer.byteLength(body);
  secrets.responseProtector("login", [
    { name: "token", json_pointer: "/token", secret: true },
  ])?.(request);
  const response = new ResponseFixture(request, body);
  collector.request(request);
  collector.response(response);
  collector.finished(request);
  await collector.finish();
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "network-content",
      phase: "response",
      body: expect.objectContaining({ state: "unavailable" }),
      headers: expect.objectContaining({ state: "unavailable" }),
    }),
  );
  expect(response.bodyReads).toBe(1);
});
