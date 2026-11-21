import { EventEmitter } from "node:events";
import type { Page, Route } from "playwright-core";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { browserScenarioSchema } from "../domain/browserScenario.js";
import type { BrowserScenarioAction } from "../domain/browserScenarioValues.js";
import { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import { scenarioSerializationAllowance } from "./BrowserScenarioSerialization.js";
import { responsePointerValue } from "./BrowserScenarioResponseValues.js";
import { performPlaywrightScenarioAction } from "./PlaywrightScenarioActions.js";
import { phaseArrival } from "../../tests/support/lifecycleHarness.js";

const ORIGIN = "https://app.example.test";

const scenario = (actions: readonly unknown[], secrets: unknown[] = []) =>
  browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: "/opt/chromium/chrome" },
    start_url: { url: `${ORIGIN}/` },
    actions,
    storage: { cookies: [], local_storage: [], session_storage: [] },
    secrets,
    capture: {},
  });

const requestStep = (fields: Record<string, unknown>) => ({
  step_id: "create",
  action: "request",
  method: "POST",
  path: "/api/folders",
  ...fields,
});

const issues = (actions: readonly unknown[], secrets: unknown[] = []) => {
  const parsed = browserScenarioSchema.safeParse({
    browser: { mode: "launch", executable_path: "/opt/chromium/chrome" },
    start_url: { url: `${ORIGIN}/` },
    actions,
    storage: { cookies: [], local_storage: [], session_storage: [] },
    secrets,
    capture: {},
  });
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => issue.message);
};

describe("request step schema", () => {
  it("refuses repeated header names, User-Agent and line breaks in literal values or prefixes", () => {
    const literal = (value: string) => ({ source: "literal", value });
    expect(
      issues([
        requestStep({
          headers: [
            { name: "X-A", value: literal("one") },
            { name: "x-a", value: literal("two") },
          ],
        }),
      ]),
    ).toContainEqual(expect.stringContaining("more than once"));
    expect(
      issues([
        requestStep({
          headers: [{ name: "User-Agent", value: literal("agent") }],
        }),
      ]),
    ).toContainEqual(expect.stringContaining("cannot set"));
    expect(
      issues([requestStep({ expected_status: [200, 303] })]),
    ).toContainEqual(expect.stringContaining("3xx"));
    for (const header of [
      { name: "X-A", value: literal("a\r\nX-B: b") },
      { name: "X-A", value: literal("a"), prefix: "Bearer\n" },
    ])
      expect(issues([requestStep({ headers: [header] })])).toContainEqual(
        expect.stringContaining("line breaks"),
      );
  });

  it("accepts a declared secret as a request header value", () => {
    const parsed = scenario(
      [
        requestStep({
          headers: [
            {
              name: "Authorization",
              value: { source: "secret", secret_id: "token" },
              prefix: "Bearer ",
            },
          ],
        }),
      ],
      [{ secret_id: "token", environment_variable: "APP_TOKEN" }],
    );
    expect(parsed.actions[0]).toMatchObject({
      action: "request",
      headers: [
        {
          name: "Authorization",
          value: { source: "secret", secret_id: "token" },
          prefix: "Bearer ",
        },
      ],
    });
  });

  it("refuses paths that leave the start origin", () => {
    for (const path of [
      "//evil.test/x",
      "/\\evil.test/x",
      "https://evil.test/",
      "/\n/[bad]",
    ])
      expect(issues([requestStep({ path })]).length, path).toBeGreaterThan(0);
  });

  it("refuses a body on GET, a header fetch cannot set and an undeclared secret", () => {
    expect(
      issues([requestStep({ method: "GET", json: { a: 1 } })]),
    ).toContainEqual(expect.stringContaining("cannot send a body"));
    expect(
      issues([
        requestStep({
          headers: [
            { name: "Cookie", value: { source: "literal", value: "a=b" } },
          ],
        }),
      ]),
    ).toContainEqual(expect.stringContaining("cannot set this header"));
    expect(
      issues([
        requestStep({
          headers: [
            { name: "X-Key", value: { source: "secret", secret_id: "key" } },
          ],
        }),
      ]),
    ).toContainEqual(expect.stringContaining("not declared"));
  });
});

interface FakeFetch {
  readonly url: string;
  readonly init: RequestInit;
}

const fakePage = (options: {
  readonly url?: string;
  /** The origin the page reports when the request is sent, if it moved after the check. */
  readonly sendingOrigin?: string;
  readonly cookies?: readonly { name: string; value: string }[];
  readonly storage?: Record<string, string>;
}) => {
  const url = options.url ?? `${ORIGIN}/dashboard`;
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => options.storage?.[key] ?? null,
  });
  vi.stubGlobal("location", {
    origin: options.sendingOrigin ?? new URL(url).origin,
  });
  const context = { cookies: async () => options.cookies ?? [] };
  return {
    on: vi.fn(),
    off: vi.fn(),
    route: async () => {},
    unroute: async () => {},
    url: () => url,
    context: () => context,
    evaluate: async <Arg, Result>(
      fn: (arg: Arg) => Result | Promise<Result>,
      arg: Arg,
    ): Promise<Result> => {
      // Like Playwright, run the callback from its source text with a cloned
      // argument, so it cannot reach this module's imports or closures.
      const pageFunction = new Function(
        "arg",
        `return (${fn.toString()})(arg);`,
      ) as (arg: Arg) => Result | Promise<Result>;
      return await pageFunction(structuredClone(arg));
    },
  } as unknown as Page;
};

const stubFetch = (status: number, bodies: readonly string[] = []) => {
  const calls: FakeFetch[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(bodies[calls.length - 1] ?? "{}", { status });
  });
  return calls;
};

const perform = async (
  page: Page,
  action: BrowserScenarioAction,
  secrets: BrowserScenarioSecrets,
  signal?: AbortSignal,
) =>
  performPlaywrightScenarioAction({
    page,
    action,
    secrets,
    startOrigin: ORIGIN,
    signal,
  });

const resolved = (parsed: ReturnType<typeof scenario>, environment = {}) => {
  const secrets = BrowserScenarioSecrets.resolve(parsed, environment);
  if (!secrets.ok) throw secrets.error;
  return secrets.value;
};

describe("request step execution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends requests with same-origin credentials", async () => {
    const calls = stubFetch(200);
    const parsed = scenario([requestStep({})]);
    await perform(fakePage({}), parsed.actions[0]!, resolved(parsed));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.credentials).toBe("same-origin");
  });

  it("refuses to run off the start origin, and fails on an unexpected status or a missing cookie", async () => {
    stubFetch(403);
    const parsed = scenario([requestStep({ expected_status: [200, 201] })]);
    const action = parsed.actions[0]!;
    await expect(
      perform(
        fakePage({ url: "https://other.test/" }),
        action,
        resolved(parsed),
      ),
    ).rejects.toThrow("start origin");
    await expect(
      perform(fakePage({}), action, resolved(parsed)),
    ).rejects.toThrow("answered 403; expected 200 or 201");
    const withCookie = scenario([
      requestStep({
        headers: [{ name: "X-T", value: { source: "cookie", name: "absent" } }],
      }),
    ]);
    await expect(
      perform(fakePage({}), withCookie.actions[0]!, resolved(withCookie)),
    ).rejects.toThrow("cookie absent is not set");
  });

  it("completes on any status when none is expected and reports fetch errors", async () => {
    stubFetch(500);
    const parsed = scenario([requestStep({})]);
    await expect(
      perform(fakePage({}), parsed.actions[0]!, resolved(parsed)),
    ).resolves.toBeUndefined();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(
      perform(fakePage({}), parsed.actions[0]!, resolved(parsed)),
    ).rejects.toThrow("Failed to fetch");
  });
});

const useRequestClock = () => {
  vi.useFakeTimers();
  onTestFinished(() => void vi.useRealTimers());
};

describe("request dispatch boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends nothing when browser evaluation starts after the absolute deadline", async () => {
    useRequestClock();
    const calls = stubFetch(200);
    const page = fakePage({});
    const evaluate = page.evaluate.bind(page);
    vi.spyOn(page, "evaluate").mockImplementation((fn, arg) => {
      // Advance the page clock at evaluation without expiring the host's monotonic clock.
      vi.setSystemTime(Date.now() + 20);
      return evaluate(fn, arg);
    });
    const parsed = scenario([requestStep({ timeout_ms: 20 })]);
    await expect(
      perform(page, parsed.actions[0]!, resolved(parsed)),
    ).rejects.toThrow("The request ran out of time before it was sent");
    expect(calls).toEqual([]);
  });

  it("aborts a dispatched fetch when the remaining budget expires", async () => {
    useRequestClock();
    const dispatched = phaseArrival<AbortSignal>();
    vi.stubGlobal(
      "fetch",
      async (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal!;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          dispatched.arrive(signal);
        }),
    );
    const parsed = scenario([requestStep({ timeout_ms: 20 })]);
    const result = perform(
      fakePage({}),
      parsed.actions[0]!,
      resolved(parsed),
    ).catch((cause: unknown) => cause);
    const signal = await dispatched.reached(result, "page fetch");
    await vi.advanceTimersByTimeAsync(19);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.reason).toMatchObject({ name: "TimeoutError" });
    expect(await result).toMatchObject({
      message: expect.stringContaining("The request ran out of time."),
    });
  });

  it("guards dispatch after cancellation while evaluation was queued, and removes its route", async () => {
    const parsed = scenario([requestStep({})]);
    const controller = new AbortController();
    const page = fakePage({});
    let gate: ((route: Route) => Promise<void>) | undefined;
    vi.spyOn(page, "route").mockImplementation(async (_match, handler) => {
      gate = handler as typeof gate;
      return {
        dispose: async () => undefined,
        [Symbol.asyncDispose]: async () => undefined,
      };
    });
    const unroute = vi.spyOn(page, "unroute");
    const sent = vi.fn();
    vi.spyOn(page, "evaluate").mockImplementation(async (fn, arg) => {
      controller.abort("abandoned while queued");
      return (fn as (arg: unknown) => unknown)(arg);
    });
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      if (gate === undefined) throw new Error("Missing dispatch owner");
      await gate({
        request: () => ({
          method: () => init.method,
          postData: () => init.body ?? null,
        }),
        fallback: sent,
        abort: async () => {
          throw new Error("aborted at dispatch");
        },
      } as unknown as Route);
      return new Response("{}", { status: 200 });
    });
    await expect(
      performPlaywrightScenarioAction({
        page,
        action: parsed.actions[0]!,
        secrets: resolved(parsed),
        startOrigin: ORIGIN,
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted at dispatch");
    expect(sent).not.toHaveBeenCalled();
    expect(unroute).toHaveBeenCalledOnce();
  });
});

describe("request route cleanup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    [200, "evaluation"],
    [503, "cleanup"],
    [200, "cleanup"],
    [200, "cancellation"],
    [503, "cancellation"],
    [200, "deadline"],
    [503, "deadline"],
    [200, "complete"],
  ] as const)(
    "settles response publication for status %i at %s",
    async (status, end) => {
      const evaluationFails = end === "evaluation";
      const cleanupFails = evaluationFails || end === "cleanup";
      const events = new EventEmitter();
      const page = Object.assign(fakePage({}), {
        on: events.on.bind(events),
        off: events.off.bind(events),
      });
      const sent = {
        url: () => `${ORIGIN}/api/folders`,
        method: () => "POST",
        postData: () => null,
      };
      const parsed = scenario([
        requestStep({
          expected_status: [200],
          timeout_ms: 5_000,
          save: [{ name: "id", json_pointer: "/id", secret: true }],
        }),
      ]);
      const secrets = resolved(parsed);
      const savedValue = "scenario-saved-id";
      vi.stubGlobal("fetch", async () => {
        events.emit("request", sent);
        return new Response(JSON.stringify({ id: savedValue }), { status });
      });

      const primary = new Error("page.evaluate: Target page has been closed");
      const cleanup = new Error("page.unroute: Target page has been closed");
      const cancel = new AbortController();
      const began = performance.now();
      if (evaluationFails)
        vi.spyOn(page, "evaluate").mockRejectedValue(primary);
      const unroute = vi.spyOn(page, "unroute").mockImplementation(async () => {
        if (cleanupFails) throw cleanup;
        if (end === "cancellation")
          cancel.abort("cancelled during final route cleanup");
        if (end === "deadline") {
          const now = vi
            .spyOn(performance, "now")
            .mockReturnValue(began + 6_000);
          onTestFinished(() => now.mockRestore());
        }
      });
      const failure = await perform(
        page,
        parsed.actions[0]!,
        secrets,
        cancel.signal,
      ).catch((cause: unknown) => cause);
      expect(unroute).toHaveBeenCalledOnce();
      expect(events.listenerCount("request")).toBe(0);
      expect(secrets.hasResponseProtection(sent)).toBe(
        evaluationFails !== true,
      );
      if (end === "complete") {
        expect(failure).toBeUndefined();
        cancel.abort("cancelled after publication");
        expect(secrets.savedValue("id")).toBe(savedValue);
        expect(secrets.responseSecretsReady(sent)).toBe(true);
        return;
      }

      expect(() => secrets.savedValue("id")).toThrow("No earlier step saved");
      expect(secrets.responseSecretsReady(sent)).toBe(false);
      if (cleanupFails && (evaluationFails || status === 503)) {
        if (!(failure instanceof AggregateError))
          throw new Error("Expected request and cleanup errors");
        expect(failure.errors).toHaveLength(2);
        expect(failure.errors[1]).toBe(cleanup);
        if (evaluationFails) expect(failure.cause).toBe(primary);
        else expect(failure.errors[0].message).toContain("answered 503");
        expect(failure.cause).toBe(failure.errors[0]);
      } else if (cleanupFails) {
        expect(failure).toBe(cleanup);
      } else {
        expect(failure).toMatchObject({
          message: expect.stringContaining(
            status === 503 ? "answered 503" : "ended before",
          ),
        });
      }
    },
  );
});

describe("request page boundaries", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses foreign-origin storage before reading its value", async () => {
    const calls = stubFetch(200);
    const read = vi.fn();
    const parsed = scenario([
      requestStep({
        headers: [
          {
            name: "Authorization",
            value: { source: "local_storage", key: "token" },
          },
        ],
      }),
    ]);
    const page = fakePage({ sendingOrigin: "https://other.test" });
    vi.stubGlobal("localStorage", { getItem: read });
    await expect(
      perform(page, parsed.actions[0]!, resolved(parsed)),
    ).rejects.toThrow("local storage");
    expect(read).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it.each([
    { label: "discarded response", chunks: 8, save: [] },
    {
      label: "oversized saved response",
      chunks: 3_000_000,
      save: [{ name: "folder", json_pointer: "/id" }],
    },
  ])(
    "bounds response retention and releases the reader for a $label",
    async ({ chunks, save }) => {
      const packet = { done: false, value: new Uint8Array(chunks).fill(97) };
      const read = vi
        .fn()
        .mockResolvedValueOnce(packet)
        .mockResolvedValueOnce(packet)
        .mockResolvedValue({ done: true });
      const cancel = vi.fn();
      const releaseLock = vi.fn();
      const arrayBuffer = vi.fn();
      vi.stubGlobal("fetch", async () => ({
        status: 200,
        type: "basic",
        body: { getReader: () => ({ read, cancel, releaseLock }) },
        arrayBuffer,
      }));
      const parsed = scenario([requestStep({ save })]);
      const request = perform(
        fakePage({}),
        parsed.actions[0]!,
        resolved(parsed),
      );
      if (save.length > 0) {
        await expect(request).rejects.toThrow("too large to save values from");
        expect(read).toHaveBeenCalledTimes(2);
        expect(cancel).toHaveBeenCalledOnce();
      } else {
        await request;
        expect(read).toHaveBeenCalledTimes(3);
        expect(cancel).not.toHaveBeenCalled();
      }
      expect(releaseLock).toHaveBeenCalledOnce();
      expect(arrayBuffer).not.toHaveBeenCalled();
    },
  );
});

describe("request step confinement", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows no redirect and sends nothing once the page has left the start origin", async () => {
    const calls: FakeFetch[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        type: "opaqueredirect",
        status: 0,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    });
    const parsed = scenario([requestStep({})]);
    const onOpaqueRedirect = vi.fn();
    await expect(
      performPlaywrightScenarioAction({
        page: fakePage({}),
        action: parsed.actions[0]!,
        secrets: resolved(parsed),
        startOrigin: ORIGIN,
        onOpaqueRedirect,
      }),
    ).rejects.toThrow("request steps do not follow");
    expect(onOpaqueRedirect).toHaveBeenCalledOnce();
    expect(calls[0]!.init.redirect).toBe("manual");
    await expect(
      perform(
        fakePage({ sendingOrigin: "https://other.test" }),
        parsed.actions[0]!,
        resolved(parsed),
      ),
    ).rejects.toThrow("the page moved");
    expect(calls).toHaveLength(1);
  });

  it.each(["deadline", "cancellation"])(
    "installs no dispatch route after %s during header reads",
    async (end) => {
      useRequestClock();
      const cancel = new AbortController();
      const page = fakePage({
        cookies: [{ name: "t", value: "token-value-1" }],
      });
      const context = page.context();
      const readCookies = context.cookies.bind(context);
      vi.spyOn(context, "cookies").mockImplementation(async (urls) => {
        if (end === "deadline") await vi.advanceTimersByTimeAsync(20);
        else cancel.abort("cancelled during header read");
        return readCookies(urls);
      });
      const route = vi.spyOn(page, "route");
      const calls = stubFetch(200);
      const parsed = scenario([
        requestStep({
          timeout_ms: 20,
          headers: [{ name: "X-T", value: { source: "cookie", name: "t" } }],
        }),
      ]);
      const failure = await perform(
        page,
        parsed.actions[0]!,
        resolved(parsed),
        cancel.signal,
      ).catch((cause: unknown) => cause);
      expect(route).not.toHaveBeenCalled();
      expect(failure).toMatchObject({
        message: expect.stringContaining(
          "ran out of time before its request was sent",
        ),
      });
      expect(calls).toEqual([]);
    },
  );

  it("appends query entries after the path's literal query without re-encoding it", async () => {
    const calls = stubFetch(200);
    const parsed = scenario([
      requestStep({
        path: "/api/items?flag&a=b%20c&s=x;y",
        query: [
          { name: "q", value: { source: "literal", value: "a b私😀!~'" } },
        ],
      }),
    ]);
    await perform(fakePage({}), parsed.actions[0]!, resolved(parsed));
    expect(calls[0]!.url).toBe(
      `${ORIGIN}/api/items?flag&a=b%20c&s=x;y&q=a%20b%E7%A7%81%F0%9F%98%80!~'`,
    );
    for (const [path, sent] of [
      ["/api/items?", "/api/items?q=1"],
      ["/api/items#", "/api/items?q=1"],
      ["/api/items?a=1&", "/api/items?a=1&q=1"],
      ["/api/items?a=1#top", "/api/items?a=1&q=1"],
    ] as const) {
      const edge = scenario([
        requestStep({
          path,
          query: [{ name: "q", value: { source: "literal", value: "1" } }],
        }),
      ]);
      await perform(fakePage({}), edge.actions[0]!, resolved(edge));
      expect(calls.at(-1)!.url, path).toBe(`${ORIGIN}${sent}`);
    }
  });
});

describe("request page value admission", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves exact local storage pointer values and refuses lossy numbers before dispatch", async () => {
    const calls = stubFetch(200);
    const parsed = scenario([
      requestStep({
        headers: [
          {
            name: "X-Account",
            value: {
              source: "local_storage",
              key: "auth",
              json_pointer: "/id",
            },
          },
        ],
      }),
    ]);
    for (const literal of ["9007199254740993", "1e400", "-0"]) {
      await expect(
        perform(
          fakePage({ storage: { auth: `{"id":${literal}}` } }),
          parsed.actions[0]!,
          resolved(parsed),
        ),
      ).rejects.toThrow("cannot be read exactly");
    }
    expect(calls).toEqual([]);
    for (const [literal, expected] of [
      ["9007199254740991", "9007199254740991"],
      ['"9007199254740993"', "9007199254740993"],
      ["42", "42"],
    ]) {
      await perform(
        fakePage({
          storage: { auth: `{"id":${literal},"unselected":9007199254740993}` },
        }),
        parsed.actions[0]!,
        resolved(parsed),
      );
      expect(calls.at(-1)!.init.headers).toEqual([["X-Account", expected]]);
    }
  });

  it("refuses page values a header cannot carry, and stored values it cannot read", async () => {
    const calls = stubFetch(200);
    const header = (value: Record<string, unknown>) =>
      scenario([requestStep({ headers: [{ name: "X-T", value }] })]);
    const cookie = header({ source: "cookie", name: "t" });
    await expect(
      perform(
        fakePage({ cookies: [{ name: "t", value: "a\r\nX-B: b" }] }),
        cookie.actions[0]!,
        resolved(cookie),
      ),
    ).rejects.toThrow("cannot carry");
    for (const [storage, pointer, message] of [
      [{}, undefined, "local storage has no auth"],
      [{ auth: "not json" }, "/token", "is not JSON"],
      [{ auth: '{"other":1}' }, "/token", "no string or number at /token"],
    ] as const) {
      const stored = header({
        source: "local_storage",
        key: "auth",
        ...(pointer === undefined ? {} : { json_pointer: pointer }),
      });
      await expect(
        perform(fakePage({ storage }), stored.actions[0]!, resolved(stored)),
      ).rejects.toThrow(message);
    }
    expect(calls).toEqual([]);
  });
});

describe("page value redaction", () => {
  const secrets = () => resolved(scenario([requestStep({})]));

  it("keeps the first marker and masks new spellings under the same label", () => {
    const held = secrets();
    const label = "write.X-Token";
    const first = "first-token-AAAA";
    const second = "second-token-BBBB";
    held.admitPageValue(label, first);
    held.admitPageValue("retry.X-Token", first);
    held.admitPageValue(label, ` ${second}\t`);
    expect(held.redact(first)).toBe("[REDACTED:page:write.X-Token]");
    const redacted = held.redact(`X-Token:  ${second}\t as sent: ${second}`);
    expect(redacted).not.toContain(second);
  });

  it("redacts values at the page-value threshold without removing shorter identifiers", () => {
    const held = secrets();
    held.admitPageValue("s.X-Org-Id", "1");
    held.admitPageValue("s.X-Port", "3000");
    held.admitPageValue("s.X-Short-Id", "seven77");
    held.admitPageValue("s.X-Boundary", "eight888");
    const ordinary = "http://127.0.0.1:3000/api/items/seven77?page=1";
    expect(held.redact(`${ordinary} eight888`)).toBe(
      `${ordinary} [REDACTED:page:s.X-Boundary]`,
    );
  });
});

const savedValue = (name: string) => ({ source: "saved", name });
const saveIdStep = (stepId: string, name: string) =>
  requestStep({
    step_id: stepId,
    save: [{ name, json_pointer: "/id" }],
  });
const clickSavingItem = (name: string) => ({
  step_id: "save-item",
  action: "click",
  locator: { kind: "role", role: "button", name: "Save" },
  save_response: {
    method: "POST",
    path: "/api/items",
    save: [{ name, json_pointer: "/id" }],
  },
});
const gotoStep = (url: string) => ({
  step_id: "open",
  action: "goto",
  destination: { url },
  wait_until: "load",
});

describe("saved value schema", () => {
  it("refuses a saved value no earlier step saves, wherever a step sends it", () => {
    const sendsItem = requestStep({
      step_id: "edit",
      method: "PUT",
      path: "/api/items/{saved:item}",
    });
    expect(issues([sendsItem])).toEqual([
      "Step edit sends saved value item, which no earlier step saves",
    ]);
    expect(issues([sendsItem, saveIdStep("create", "item")])).toContainEqual(
      expect.stringContaining("which no earlier step saves"),
    );
    expect(issues([saveIdStep("create", "item"), sendsItem])).toEqual([]);
    expect(issues([clickSavingItem("item"), sendsItem])).toEqual([]);
    for (const step of [
      gotoStep(`${ORIGIN}/items/{saved:item}`),
      gotoStep(`${ORIGIN}/items/%7Bsaved%3Aitem%7D`),
      requestStep({ path: "/api/items?parent={saved:item}" }),
      requestStep({ json: { list: [{ parent: "{saved:item}" }] } }),
      requestStep({ json: { note: "Copied from {saved:item}" } }),
      requestStep({ headers: [{ name: "X-Item", value: savedValue("item") }] }),
      requestStep({
        headers: [
          {
            name: "Authorization",
            value: {
              source: "basic_credentials",
              parts: [savedValue("item"), { source: "literal", value: "x" }],
            },
          },
        ],
      }),
    ])
      expect(issues([step]), JSON.stringify(step)).toContainEqual(
        expect.stringContaining("sends saved value item"),
      );
  });

  it("reads only `{saved:name}` as written in a JSON string, not its encoded spelling", () => {
    expect(
      issues([requestStep({ json: { note: "%7Bsaved:item%7D" } })]),
    ).toEqual([]);
  });

  it("sends other braces as written", () => {
    expect(
      issues([
        gotoStep(`${ORIGIN}/search/{q}`),
        requestStep({ path: "/api/items/{id}", json: { name: "{draft}" } }),
      ]),
    ).toEqual([]);
  });
});

describe("saved value schema: credentials and response paths", () => {
  it("refuses a literal Basic password, which Evidence would record as written", () => {
    const basic = (password: unknown) =>
      requestStep({
        headers: [
          {
            name: "Authorization",
            value: {
              source: "basic_credentials",
              parts: [{ source: "literal", value: "admin" }, password],
            },
          },
        ],
      });
    expect(
      issues([basic({ source: "literal", value: "hunter2" })]),
    ).toContainEqual(expect.stringContaining("not a literal"));
    expect(issues([basic({ source: "literal", value: "" })])).toEqual([]);
  });

  it("builds Basic credentials from page values and refuses undeclared secret parts", () => {
    const basic = (username: unknown, password: unknown) =>
      requestStep({
        headers: [
          {
            name: "Authorization",
            value: { source: "basic_credentials", parts: [username, password] },
            prefix: "Basic ",
          },
        ],
      });
    expect(
      issues([
        basic(
          { source: "local_storage", key: "user", json_pointer: "/name" },
          { source: "cookie", name: "pw" },
        ),
      ]),
    ).toEqual([]);
    expect(
      issues([
        basic(
          { source: "literal", value: "admin" },
          { source: "secret", secret_id: "password" },
        ),
      ]),
    ).toContainEqual(expect.stringContaining("not declared"));
    const literal = { source: "literal", value: "admin" };
    expect(
      issues([
        requestStep({
          headers: [
            {
              name: "Authorization",
              value: { source: "basic_credentials", parts: [literal] },
            },
          ],
        }),
      ]).length,
    ).toBeGreaterThan(0);
  });

  it("requires a save_response to name a same-origin path and something to save", () => {
    const click = (saveResponse: unknown) => ({
      ...clickSavingItem("item"),
      save_response: saveResponse,
    });
    for (const path of ["//evil.test/api", "api/items", "https://evil.test/"])
      expect(
        issues([
          click({
            method: "POST",
            path,
            save: [{ name: "item", json_pointer: "/id" }],
          }),
        ]).length,
        path,
      ).toBeGreaterThan(0);
    expect(
      issues([click({ method: "POST", path: "/api/items", save: [] })]).length,
    ).toBeGreaterThan(0);
  });
});

describe("saved value execution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends saved ids in the path and body with their saved type, and a saved secret only redacted", async () => {
    const calls = stubFetch(200, [
      '{"id":42,"session":{"token":"session-token-9f3e"}}',
    ]);
    const parsed = scenario([
      requestStep({
        json: { title: "Scratch folder 1" },
        save: [
          { name: "folder", json_pointer: "/id" },
          { name: "token", json_pointer: "/session/token", secret: true },
        ],
      }),
      requestStep({
        step_id: "move",
        method: "PUT",
        path: "/api/folders/{saved:folder}",
        json: {
          title: "Moved",
          parent: "{saved:folder}",
          note: "Moved into {saved:folder}",
        },
        headers: [
          {
            name: "Authorization",
            value: { source: "saved", name: "token" },
            prefix: "Bearer ",
          },
        ],
      }),
    ]);
    const secrets = resolved(parsed);
    const page = fakePage({});
    for (const action of parsed.actions) await perform(page, action, secrets);
    expect(calls[1]).toEqual({
      url: `${ORIGIN}/api/folders/42`,
      init: expect.objectContaining({
        method: "PUT",
        headers: [
          ["Authorization", "Bearer session-token-9f3e"],
          ["content-type", "application/json"],
        ],
        body: '{"title":"Moved","parent":42,"note":"Moved into 42"}',
      }),
    });
    expect(secrets.redact("folder 42 with session-token-9f3e")).toBe(
      "folder 42 with [REDACTED:page:create.token]",
    );
  });
});

describe("saved value credentials and limits", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a JSON string that spells a placeholder percent-encoded as written", async () => {
    const calls = stubFetch(200, ['{"id":7}']);
    const parsed = scenario([
      requestStep({ save: [{ name: "item", json_pointer: "/id" }] }),
      requestStep({
        step_id: "note",
        json: { note: "%7Bsaved:item%7D", id: "{saved:item}" },
      }),
    ]);
    const secrets = resolved(parsed);
    for (const action of parsed.actions)
      await perform(fakePage({}), action, secrets);
    expect(calls[1]!.init.body).toBe('{"note":"%7Bsaved:item%7D","id":7}');
  });

  it("fails a step whose response holds no value to save", async () => {
    stubFetch(200, ['{"items":[]}', "not json"]);
    const parsed = scenario([
      requestStep({ save: [{ name: "folder", json_pointer: "/id" }] }),
    ]);
    const secrets = resolved(parsed);
    await expect(
      perform(fakePage({}), parsed.actions[0]!, secrets),
    ).rejects.toThrow("no string or number at /id to save as folder");
    await expect(
      perform(fakePage({}), parsed.actions[0]!, secrets),
    ).rejects.toThrow("is not JSON");
    expect(() => secrets.savedValue("folder")).toThrow();
  });

  it.each([
    { source: "declared secrets", username: "a", password: "b" },
    {
      source: "page storage",
      username: "operator-7",
      password: "cookie-key-5d1c",
    },
  ])(
    "sends Basic credentials from $source and masks the source values and the encoded header",
    async ({ source, username, password }) => {
      const declared = source === "declared secrets";
      const calls = stubFetch(200, ['{"pin":"x7"}']);
      const name = declared ? "X-Auth" : "Authorization";
      const prefix = declared ? "" : "Basic ";
      const parsed = scenario(
        [
          requestStep({
            headers: [
              {
                name,
                prefix,
                value: {
                  source: "basic_credentials",
                  parts: declared
                    ? [
                        { source: "secret", secret_id: "user" },
                        { source: "secret", secret_id: "password" },
                      ]
                    : [
                        {
                          source: "local_storage",
                          key: "user",
                          json_pointer: "/name",
                        },
                        { source: "cookie", name: "api_key" },
                      ],
                },
              },
            ],
            save: [{ name: "pin", json_pointer: "/pin", secret: true }],
          }),
        ],
        declared
          ? [
              { secret_id: "user", environment_variable: "APP_USER" },
              { secret_id: "password", environment_variable: "APP_PASSWORD" },
            ]
          : [],
      );
      const secrets = resolved(
        parsed,
        declared ? { APP_USER: username, APP_PASSWORD: password } : {},
      );
      const page = fakePage(
        declared
          ? {}
          : {
              cookies: [{ name: "api_key", value: password }],
              storage: { user: JSON.stringify({ name: username }) },
            },
      );
      await perform(page, parsed.actions[0]!, secrets);

      const encoded = Buffer.from(`${username}:${password}`).toString("base64");
      expect(calls[0]!.init.headers).toEqual([[name, prefix + encoded]]);
      expect(secrets.savedValue("pin")).toBe("x7");
      for (const value of [encoded, username, password, "x7"])
        expect(secrets.redact(value)).toMatch(/^\[REDACTED(?::.+)?\]$/u);
    },
  );
});

describe("saved response JSON pointers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("selects the root and decodes escaped response keys once", () => {
    const value = { "a/b": { "~1": "literal", "/": "slash" } };
    expect(responsePointerValue(value, "")).toBe(value);
    expect(responsePointerValue(value, "/a~1b/~01")).toBe("literal");
  });

  it("does not coerce a terminal newline in an array index", () => {
    expect(responsePointerValue({ items: ["record-7"] }, "/items/0\n")).toBe(
      undefined,
    );
  });

  it.each(["length", "01", "-"])(
    "refuses the non-index array token %s",
    async (token) => {
      stubFetch(201, ['{"items":["record-7","record-8"]}']);
      const parsed = scenario([
        requestStep({
          save: [{ name: "item", json_pointer: `/items/${token}` }],
        }),
      ]);
      const secrets = resolved(parsed);
      await expect(
        perform(fakePage({}), parsed.actions[0]!, secrets),
      ).rejects.toThrow("has no string or number");
      expect(() => secrets.savedValue("item")).toThrow("No earlier step saved");
    },
  );

  it.each([
    ["/items/0", "record-7"],
    ["/length", 12],
    ["/01", "object-key"],
    ["/a~1b/~0key", "escaped-key"],
  ])("preserves JSON member identity at %s", async (pointer, expected) => {
    stubFetch(201, [
      '{"items":["record-7"],"length":12,"01":"object-key","a/b":{"~key":"escaped-key"}}',
    ]);
    const parsed = scenario([
      requestStep({ save: [{ name: "item", json_pointer: pointer }] }),
    ]);
    const secrets = resolved(parsed);
    await perform(fakePage({}), parsed.actions[0]!, secrets);
    expect(secrets.savedValue("item")).toBe(expected);
  });
});

describe("saved response number identity", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["0", 0],
    ["0.0", 0],
    ["1.5", 1.5],
    ["12.50", 12.5],
    ["1E2", 100],
    ["0.1", 0.1],
    ['"record-7"', "record-7"],
    ["-0", undefined, "cannot be saved exactly"],
    ["1e-400", undefined, "cannot be saved exactly"],
    ["-1e-400", undefined, "cannot be saved exactly"],
    ["1.0000000000000000001", undefined, "cannot be saved exactly"],
    ["9007199254740993", undefined, "cannot be saved exactly"],
    ["1e400", undefined, "not finite"],
    ["-1e400", undefined, "not finite"],
  ] as const)(
    "preserves saved response value identity for %s",
    async (token, kept, refusal?: string) => {
      stubFetch(201, [
        `{"id":${token},"companion":"stable","unselected":1e-400}`,
      ]);
      const parsed = scenario([
        requestStep({
          save: [
            { name: "companion", json_pointer: "/companion" },
            { name: "item", json_pointer: "/id" },
          ],
        }),
      ]);
      const secrets = resolved(parsed);
      const attempt = perform(fakePage({}), parsed.actions[0]!, secrets);
      if (refusal === undefined) {
        await attempt;
        expect(secrets.savedValue("item")).toBe(kept);
        expect(secrets.savedValue("companion")).toBe("stable");
      } else {
        await expect(attempt).rejects.toThrow(refusal);
        expect(() => secrets.savedValue("item")).toThrow(
          "No earlier step saved item",
        );
        expect(() => secrets.savedValue("companion")).toThrow(
          "No earlier step saved companion",
        );
      }
    },
  );
});

describe("values a URL path or Basic header cannot carry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails a Basic header whose username holds a colon, before sending it", async () => {
    const calls = stubFetch(200, ["{}"]);
    const parsed = scenario(
      [
        requestStep({
          headers: [
            {
              name: "Authorization",
              value: {
                source: "basic_credentials",
                parts: [
                  { source: "secret", secret_id: "user" },
                  { source: "secret", secret_id: "password" },
                ],
              },
            },
          ],
        }),
      ],
      [
        { secret_id: "user", environment_variable: "APP_USER" },
        { secret_id: "password", environment_variable: "APP_PASSWORD" },
      ],
    );
    const secrets = resolved(parsed, {
      APP_USER: "ops:admin",
      APP_PASSWORD: "b",
    });
    await expect(
      perform(fakePage({}), parsed.actions[0]!, secrets),
    ).rejects.toThrow("Basic username with a colon");
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["/items/{saved:item}/edit", "."],
    ["/items/{saved:item}/edit", ".."],
    ["/items/{saved:item}.", "."],
    ["/items/%2e{saved:item}", "."],
    ["/safe\\{saved:item}.", "."],
    ["/safe\\%2e{saved:item}", "."],
  ])(
    "rejects %s with saved %s before navigation or request dispatch",
    async (path, saved) => {
      const parsed = scenario([
        requestStep({ save: [{ name: "item", json_pointer: "/id" }] }),
        {
          step_id: "open",
          action: "goto",
          destination: { url: ORIGIN + path },
          wait_until: "load",
        },
        requestStep({ step_id: "edit", path }),
      ]);
      const secrets = resolved(parsed);
      secrets.save("create.item", "item", saved, false);
      const goto = vi.fn();
      const evaluate = vi.fn();
      const page = { ...fakePage({}), goto, evaluate } as unknown as Page;
      for (const action of parsed.actions.slice(1))
        await expect(perform(page, action, secrets)).rejects.toThrow(
          "dot segment",
        );
      expect(goto).not.toHaveBeenCalled();
      expect(evaluate).not.toHaveBeenCalled();
    },
  );

  it("sends dots that are part of a segment or of the query", async () => {
    const parsed = scenario([
      requestStep({ save: [{ name: "item", json_pointer: "/id" }] }),
      {
        step_id: "open",
        action: "goto",
        destination: { url: `${ORIGIN}/items/v{saved:item}?at={saved:item}` },
        wait_until: "load",
      },
    ]);
    const secrets = resolved(parsed);
    secrets.save("create.item", "item", "..", false);
    const goto = vi.fn(async () => null);
    await perform({ goto } as unknown as Page, parsed.actions[1]!, secrets);
    expect(goto).toHaveBeenCalledWith(
      `${ORIGIN}/items/v..?at=..`,
      expect.anything(),
    );
  });
});

describe("bounded derived credentials", () => {
  it("refuses over-budget Unicode spellings before building encoded copies", () => {
    const secrets = resolved(scenario([requestStep({})]));
    const encode = vi.spyOn(globalThis, "encodeURIComponent");
    try {
      expect(() =>
        secrets.save("create.token", "token", "私".repeat(1_000_000), true),
      ).toThrow("more than 4000000 characters");
      expect(encode).not.toHaveBeenCalled();
      expect(() => secrets.savedValue("token")).toThrow(
        "No earlier step saved",
      );
    } finally {
      encode.mockRestore();
    }
  });
  it("charges distinct Basic credentials while admitting repeated identical spellings once", () => {
    const secrets = resolved(scenario([requestStep({})]));
    const password = "x".repeat(300_000);
    secrets.save("create.token", "token", password, false);
    const first = secrets.basicCredential("login.auth", "operator-0", password);
    for (let index = 0; index < 8; index++)
      expect(
        secrets.basicCredential("again.auth", "operator-0", password),
      ).toBe(first);
    expect(() => {
      for (let index = 1; index < 16; index++)
        secrets.basicCredential(
          `s${String(index)}.auth`,
          `operator-${String(index)}`,
          password,
        );
    }).toThrow("more than 4000000 characters");
    expect(secrets.savedValue("token")).toBe(password);
    expect(secrets.redact(first)).not.toContain(first);
  });

  it("refuses excessive base64 expansion before allocating the credential buffer", () => {
    const secrets = resolved(scenario([requestStep({})]));
    const allocate = vi.spyOn(Buffer, "allocUnsafe");
    try {
      expect(() =>
        secrets.basicCredential("login.auth", "u", "x".repeat(3_000_001)),
      ).toThrow("encoded form exceeds");
      expect(allocate).not.toHaveBeenCalled();
    } finally {
      allocate.mockRestore();
    }
  });
});

describe("saved value retention", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("charges repeated identical secret saves only for retained values", () => {
    const secrets = resolved(scenario([requestStep({})]));
    const token = "s".repeat(1_000_000);
    for (let index = 0; index < 8; index++)
      secrets.save(`step${String(index)}.token`, "token", token, true);
    expect(secrets.savedValue("token")).toBe(token);
    expect(secrets.redact(token)).not.toContain(token);
  });

  it("charges trimmed secret spellings before changing either saved or redaction state", () => {
    const secrets = resolved(scenario([requestStep({})]));
    secrets.save("seed.fill", "fill", "x".repeat(3_999_000), false);
    const trimmed = "a".repeat(198);
    expect(() =>
      secrets.save("step.padded", "padded", ` ${trimmed} `, true),
    ).toThrow("more than 4000000 characters of saved values");
    expect(() => secrets.savedValue("padded")).toThrow("No earlier step saved");
    expect(secrets.redact(trimmed)).toBe(trimmed);
    expect(String(secrets.savedValue("fill"))).toHaveLength(3_999_000);
  });

  it("refuses a new saved name that would keep more than the limit, before keeping it", () => {
    const secrets = resolved(scenario([requestStep({})]));
    secrets.save("a.first", "first", "x".repeat(3_000_000), false);
    expect(() =>
      secrets.save("b.second", "second", "y".repeat(1_500_000), false),
    ).toThrow("more than 4000000 characters of saved values");
    expect(() => secrets.savedValue("second")).toThrow("No earlier step saved");
    // A later save of the same name replaces its value rather than adding to it.
    secrets.save("c.first", "first", "z".repeat(3_500_000), false);
    expect(String(secrets.savedValue("first"))).toHaveLength(3_500_000);
  });

  it("counts the redaction spellings a secret save keeps", () => {
    const plain = resolved(scenario([requestStep({})]));
    plain.save("a.token", "token", "t".repeat(2_500_000), false);
    const secret = resolved(scenario([requestStep({})]));
    expect(() =>
      secret.save("a.token", "token", "t".repeat(2_500_000), true),
    ).toThrow("more than 4000000 characters of saved values");
  });

  it("fails the step that would save past the limit", async () => {
    stubFetch(201, [`{"id":"${"y".repeat(200_000)}"}`]);
    const parsed = scenario([
      requestStep({ save: [{ name: "item", json_pointer: "/id" }] }),
    ]);
    const secrets = resolved(parsed);
    secrets.save("seed.big", "big", "x".repeat(3_900_000), false);
    await expect(
      perform(fakePage({}), parsed.actions[0]!, secrets),
    ).rejects.toThrow(
      "Step create: item cannot be saved: the scenario would keep more than",
    );
  });
});

describe("goto placeholders", () => {
  it("fills a goto destination's placeholders, percent-encoded", async () => {
    const parsed = scenario([
      requestStep({ save: [{ name: "item", json_pointer: "/id" }] }),
      {
        step_id: "open",
        action: "goto",
        destination: { url: `${ORIGIN}/items/{saved:item}/edit` },
        wait_until: "load",
      },
    ]);
    const secrets = resolved(parsed);
    secrets.save("create.item", "item", "a b/c", false);
    const goto = vi.fn(async () => null);
    await perform({ goto } as unknown as Page, parsed.actions[1]!, secrets);
    expect(goto).toHaveBeenCalledWith(
      `${ORIGIN}/items/a%20b%2Fc/edit`,
      expect.anything(),
    );
  });

  it("keeps a structured query value that spells a placeholder as written", async () => {
    const parsed = scenario([
      requestStep({ save: [{ name: "item", json_pointer: "/id" }] }),
      {
        step_id: "open",
        action: "goto",
        destination: {
          url: `${ORIGIN}/items/{saved:item}`,
          query: [
            {
              name: "note",
              value: { source: "literal", value: "{saved:item}" },
            },
          ],
        },
        wait_until: "load",
      },
    ]);
    const secrets = resolved(parsed);
    secrets.save("create.item", "item", "7", false);
    const goto = vi.fn(async () => null);
    await perform({ goto } as unknown as Page, parsed.actions[1]!, secrets);
    const [address] = goto.mock.calls[0] as unknown as [string];
    const url = new URL(address);
    expect(url.pathname).toBe("/items/7");
    expect(url.searchParams.get("note")).toBe("{saved:item}");
  });
});

interface FakeResponse {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly body: string;
  /** A request already running when the step began, such as an earlier autosave. */
  readonly earlier?: boolean;
  /** The body size the browser received, when it differs from the body's. */
  readonly size?: number;
  readonly encoding?: string;
  /** The Content-Length the response declares. */
  readonly length?: string;
  /** A body still arriving: the text resolves with it. */
  readonly late?: Promise<string>;
}

/**
 * A page whose click starts the given requests, emitting each that did not start earlier to request listeners, and
 * answers them in order; waitForResponse resolves with the first answer it names once the click acted.
 */
const uiPage = (responses: readonly FakeResponse[], clickFails = false) => {
  const order: string[] = [];
  const reads = { count: 0 };
  const listeners = new Set<(request: unknown) => void>();
  let acted: () => void = () => undefined;
  const clicked = new Promise<void>((resolve) => {
    acted = resolve;
  });
  const answers = responses.map((response) => {
    const request = {
      method: () => response.method,
      url: () => response.url,
      sizes: async () => ({
        responseBodySize: response.size ?? response.body.length,
      }),
    };
    return {
      response,
      request,
      answer: {
        request: () => request,
        url: () => response.url,
        status: () => response.status,
        headers: () => ({
          ...(response.encoding === undefined
            ? {}
            : { "content-encoding": response.encoding }),
          ...(response.length === undefined
            ? {}
            : { "content-length": response.length }),
        }),
        body: async () => {
          reads.count += 1;
          return Buffer.from(await (response.late ?? response.body));
        },
      },
    };
  });
  const page = {
    on: (_event: string, listener: (request: unknown) => void) =>
      listeners.add(listener),
    off: (_event: string, listener: (request: unknown) => void) =>
      listeners.delete(listener),
    getByRole: () => ({
      click: async () => {
        order.push("click");
        if (clickFails) throw new Error("Element is not attached");
        for (const { response, request } of answers)
          if (response.earlier !== true)
            for (const listener of listeners) listener(request);
        acted();
      },
    }),
    waitForResponse: async (
      names: (response: unknown) => boolean,
      options: { timeout?: number },
    ) => {
      order.push(`wait ${String(options.timeout)}`);
      await clicked;
      const found = answers.map(({ answer }) => answer).find(names);
      if (found === undefined) throw new Error("Timeout exceeded");
      return found;
    },
  } as unknown as Page;
  return { page, order, listeners, reads };
};

const clickSaving = (path: string) =>
  scenario([
    {
      step_id: "save-item",
      action: "click",
      timeout_ms: 5000,
      locator: { kind: "role", role: "button", name: "Save" },
      save_response: {
        method: "POST",
        path,
        save: [{ name: "item", json_pointer: "/id" }],
      },
    },
  ]);

it.each(["before response binding", "during the body read"])(
  "refuses a competing request observed %s without publishing either identity",
  async (phase) => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const parsed = clickSaving("/api/items");
    const secrets = resolved(parsed);
    const body = '{"id":"created"}';
    let finishBody!: (value: string) => void;
    const late = new Promise<string>((resolveBody) => {
      finishBody = resolveBody;
    });
    const started = { method: "POST", url: `${ORIGIN}/api/items`, status: 201 };
    const beforeBinding = phase === "before response binding";
    const { page, listeners, reads } = uiPage([
      { ...started, body, late },
      ...(beforeBinding ? [{ ...started, body: '{"id":"poll"}' }] : []),
    ]);
    const outcome = perform(page, parsed.actions[0]!, secrets).catch(
      (cause: unknown) => cause,
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(reads.count).toBe(beforeBinding ? 0 : 1);
      if (!beforeBinding) {
        for (const listener of listeners)
          listener({ method: () => started.method, url: () => started.url });
      }
    } finally {
      finishBody(body);
      await outcome;
    }
    expect(await outcome).toMatchObject({
      message: expect.stringContaining("multiple matching requests"),
    });
    expect(() => secrets.savedValue("item")).toThrow("No earlier step saved");
    expect(listeners.size).toBe(0);
  },
);

describe("saving from a UI step's response", () => {
  it("waits before clicking, and saves from the response the step names", async () => {
    const parsed = clickSaving("/api/lists/{*}/items");
    const secrets = resolved(parsed);
    const { page, order } = uiPage([
      {
        method: "GET",
        url: `${ORIGIN}/api/lists/3/items`,
        status: 200,
        body: '{"id":"read"}',
      },
      {
        method: "POST",
        url: `https://other.test/api/lists/3/items`,
        status: 201,
        body: '{"id":"foreign"}',
      },
      {
        method: "POST",
        url: `${ORIGIN}/api/lists/3/4/items`,
        status: 201,
        body: '{"id":"deeper"}',
      },
      {
        method: "POST",
        url: `${ORIGIN}/api/lists/3/items?draft=1`,
        status: 201,
        body: '{"id":"item-7"}',
      },
    ]);
    await perform(page, parsed.actions[0]!, secrets);
    expect(order).toEqual(["wait 5000", "click"]);
    expect(secrets.savedValue("item")).toBe("item-7");
  });

  it("saves from a request the step started, not one already running, and matches an encoded path", async () => {
    const parsed = clickSaving("/api/lists/My List/items");
    const secrets = resolved(parsed);
    const { page, listeners } = uiPage([
      {
        method: "POST",
        url: `${ORIGIN}/api/lists/My%20List/items`,
        status: 201,
        body: '{"id":"autosaved"}',
        earlier: true,
      },
      {
        method: "POST",
        url: `${ORIGIN}/api/lists/My%20List/items`,
        status: 201,
        body: '{"id":"item-8"}',
      },
    ]);
    await perform(page, parsed.actions[0]!, secrets);
    expect(secrets.savedValue("item")).toBe("item-8");
    expect(listeners.size).toBe(0);
  });

  it("stops watching requests when the step fails before its response", async () => {
    const parsed = clickSaving("/api/items");
    const { page, listeners } = uiPage([], true);
    await expect(
      perform(page, parsed.actions[0]!, resolved(parsed)),
    ).rejects.toThrow("Element is not attached");
    expect(listeners.size).toBe(0);
  });

  it("fails the step when no named response arrives or it is not 2xx", async () => {
    const parsed = clickSaving("/api/items");
    await expect(
      perform(uiPage([]).page, parsed.actions[0]!, resolved(parsed)),
    ).rejects.toThrow(
      "no POST /api/items response could be read, so nothing was saved: Timeout exceeded",
    );
    await expect(
      perform(
        uiPage([
          {
            method: "POST",
            url: `${ORIGIN}/api/items`,
            status: 422,
            body: '{"id":"x"}',
          },
        ]).page,
        parsed.actions[0]!,
        resolved(parsed),
      ),
    ).rejects.toThrow(
      "answered 422; values are saved only from a 2xx response",
    );
  });
});

it("retains the physical response-wait failure through late cancellation", async () => {
  const parsed = clickSaving("/api/items");
  const secrets = resolved(parsed);
  const { page, listeners } = uiPage([]);
  const primary = new Error(
    "page.waitForResponse: Target page has been closed",
  );
  vi.spyOn(page, "waitForResponse").mockRejectedValue(primary);
  const cancel = new AbortController();
  const remove = cancel.signal.removeEventListener.bind(cancel.signal);
  const removing = vi
    .spyOn(cancel.signal, "removeEventListener")
    .mockImplementation((type, listener, options) => {
      remove(type, listener, options);
      cancel.abort("cancelled after the physical wait failed");
    });
  onTestFinished(() => removing.mockRestore());
  const attempt = perform(page, parsed.actions[0]!, secrets, cancel.signal);
  await expect(attempt).rejects.toMatchObject({
    cause: primary,
    message: expect.stringContaining(primary.message),
  });
  expect(cancel.signal.aborted).toBe(true);
  expect(() => secrets.savedValue("item")).toThrow("No earlier step saved");
  expect(listeners.size).toBe(0);
});

it("retains saved values when cancellation follows completed click publication", async () => {
  const parsed = clickSaving("/api/items");
  const { page } = uiPage([
    {
      method: "POST",
      url: `${ORIGIN}/api/items`,
      status: 201,
      body: '{"id":"committed-object"}',
    },
  ]);
  const secrets = resolved(parsed);
  const cancel = new AbortController();
  await perform(page, parsed.actions[0]!, secrets, cancel.signal);
  cancel.abort("cancelled after publication");
  expect(secrets.savedValue("item")).toBe("committed-object");
});

describe("UI response body admission", () => {
  const tooLarge = "too large to save values from";
  const couldDecodePastLimit = "could decode past the size limit";
  const unknown = "decoded response size cannot be bounded";

  it.each([
    { encoding: "gzip", size: 32, length: "12000001" },
    { encoding: "deflate", size: 32 },
    { encoding: "x-gzip", size: 32 },
    { size: 0, length: "00000000000000000017" },
    { encoding: "gzip", size: 0, length: "0032" },
    { size: 12_000_001, error: tooLarge },
    {
      encoding: "gzip",
      size: 12_000,
      length: "32",
      error: couldDecodePastLimit,
    },
    { size: 0, length: "00012000001", error: couldDecodePastLimit },
    {
      encoding: "gzip",
      size: 0,
      length: "00012000",
      error: couldDecodePastLimit,
    },
    { encoding: "br", size: 32, error: unknown },
    { encoding: "gzip, zstd", size: 32, error: unknown },
    { encoding: "gzip", size: 0, error: unknown },
    ...[
      "0000",
      "+17",
      "17.0",
      "1.7e1",
      "17, 17",
      "0001000000000000000",
      "0009007199254740993",
    ].map((length) => ({ size: 0, length, error: unknown })),
    ...[-1, Number.NaN].map((size) => ({ size, error: unknown })),
  ])(
    "admits only bounded response bodies: %j",
    async ({ error, ...bounds }) => {
      const parsed = clickSaving("/api/items");
      const secrets = resolved(parsed);
      const { page, reads, listeners } = uiPage([
        {
          method: "POST",
          url: `${ORIGIN}/api/items`,
          status: 201,
          body: '{"id":"record-7"}',
          ...bounds,
        },
      ]);
      const action = perform(page, parsed.actions[0]!, secrets);
      if (error === undefined) {
        await action;
        expect(secrets.savedValue("item")).toBe("record-7");
        expect(reads.count).toBe(1);
      } else {
        await expect(action).rejects.toThrow(error);
        expect(() => secrets.savedValue("item")).toThrow(
          "No earlier step saved",
        );
        expect(reads.count).toBe(0);
      }
      expect(listeners.size).toBe(0);
    },
  );
});

describe("saved response limits and deadlines", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["deadline", "cancellation"])(
    "saves nothing when %s ends an active body read",
    async (end) => {
      vi.useFakeTimers();
      const parsed = clickSaving("/api/items");
      const secrets = resolved(parsed);
      const body = '{"id":"item-late"}';
      let finishBody!: (value: string) => void;
      const late = new Promise<string>((resolveBody) => {
        finishBody = resolveBody;
      });
      const { page, listeners, reads } = uiPage([
        {
          method: "POST",
          url: `${ORIGIN}/api/items`,
          status: 201,
          body: "",
          size: Buffer.byteLength(body),
          late,
        },
      ]);
      const cancel = new AbortController();
      const outcome = perform(
        page,
        parsed.actions[0]!,
        secrets,
        cancel.signal,
      ).catch((cause: unknown) => cause);
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(reads.count).toBe(1);
        if (end === "cancellation") cancel.abort("cancelled during body read");
        await vi.advanceTimersByTimeAsync(end === "deadline" ? 5000 : 0);
        expect(
          await Promise.race([outcome, Promise.resolve("still pending")]),
        ).toMatchObject({
          message: expect.stringContaining(
            "ended before its saved response was read",
          ),
        });
        expect(listeners.size).toBe(0);
      } finally {
        finishBody(body);
        await outcome;
      }
      expect(() => secrets.savedValue("item")).toThrow("No earlier step saved");
    },
  );

  it("saves nothing when cancellation arrives as the body wait releases its listener", async () => {
    const parsed = clickSaving("/api/items");
    const secrets = resolved(parsed);
    const { page, listeners } = uiPage([
      {
        method: "POST",
        url: `${ORIGIN}/api/items`,
        status: 201,
        body: '{"id":"late-object"}',
      },
    ]);
    const cancel = new AbortController();
    const remove = cancel.signal.removeEventListener.bind(cancel.signal);
    let waitsReleased = 0;
    const removeListener = vi
      .spyOn(cancel.signal, "removeEventListener")
      .mockImplementation((type, listener, options) => {
        remove(type, listener, options);
        if (++waitsReleased === 2)
          cancel.abort("cancelled at body wait completion");
      });
    onTestFinished(() => removeListener.mockRestore());
    await expect(
      perform(page, parsed.actions[0]!, secrets, cancel.signal),
    ).rejects.toThrow("ended before");
    expect(() => secrets.savedValue("item")).toThrow("No earlier step saved");
    expect(listeners.size).toBe(0);
  });

  it("reads a response whose received bytes exceed the character limit but whose text is within it", async () => {
    const parsed = clickSaving("/api/items");
    const secrets = resolved(parsed);
    const { page } = uiPage([
      {
        method: "POST",
        url: `${ORIGIN}/api/items`,
        status: 201,
        body: '{"id":"item-9"}',
        // Two million three-byte characters, as CJK text spells them in UTF-8.
        size: 6_000_000,
      },
    ]);
    await perform(page, parsed.actions[0]!, secrets);
    expect(secrets.savedValue("item")).toBe("item-9");
  });

  it("fails a response whose text is longer than the character limit", async () => {
    const parsed = clickSaving("/api/items");
    const { page, reads } = uiPage([
      {
        method: "POST",
        url: `${ORIGIN}/api/items`,
        status: 201,
        body: `{"id":"${"x".repeat(4_000_000)}"}`,
      },
    ]);
    await expect(
      perform(page, parsed.actions[0]!, resolved(parsed)),
    ).rejects.toThrow("too large to save values from");
    expect(reads.count).toBe(1);
  });
});

it.each(["array", "embedded", "headers"])(
  "refuses repeated large saved values in %s before expansion or browser dispatch",
  async (kind) => {
    const parsed = scenario([
      requestStep({ save: [{ name: "large", json_pointer: "/value" }] }),
      requestStep({
        step_id: "expanded",
        headers:
          kind === "headers"
            ? Array.from({ length: 1000 }, (_, i) => ({
                name: `X-Repeated-${i}`,
                value: { source: "saved" as const, name: "large" },
              }))
            : [],
        json:
          kind === "headers"
            ? undefined
            : kind === "array"
              ? Array.from({ length: 1000 }, () => "{saved:large}")
              : "prefix" + "{saved:large}".repeat(1000),
      }),
    ]);
    const secrets = resolved(parsed);
    secrets.save("source.large", "large", "x".repeat(3_000_000), false);
    const page = { url: () => ORIGIN, evaluate: vi.fn() } as unknown as Page;
    await expect(perform(page, parsed.actions[1]!, secrets)).rejects.toThrow(
      "serialization allowance",
    );
    expect(page.evaluate).not.toHaveBeenCalled();
  },
);

it.each([
  ["request", "raw query", "x", 2],
  ["request", "encoded query", "私", 0.25],
  ["goto", "encoded query", "私", 0.25],
] as const)(
  "rejects an oversized %s %s before encoding or dispatch",
  async (kind, _size, unit, allowanceFraction) => {
    const repetitions = 1_000;
    // One CJK code unit expands to nine ASCII bytes. The Unicode rows fit
    // as raw text and exceed the current heap allowance only after encoding.
    const value = unit.repeat(
      Math.ceil(
        (scenarioSerializationAllowance() * allowanceFraction) / repetitions,
      ),
    );
    const query = Array.from({ length: repetitions }, (_, index) => ({
      name: `repeated-${index}`,
      value: { source: "literal", value },
    }));
    const url = `${ORIGIN}/items?literal=a%20b#kept`;
    const parsed = scenario([
      kind === "request"
        ? requestStep({ query })
        : { ...gotoStep(url), destination: { url, query } },
    ]);
    const dispatch = vi.fn();
    const page = {
      url: () => ORIGIN,
      evaluate: dispatch,
      goto: dispatch,
    } as unknown as Page;
    const encode =
      kind === "request"
        ? vi.spyOn(globalThis, "encodeURIComponent")
        : vi.spyOn(URLSearchParams.prototype, "append");
    encode.mockImplementation(() => {
      throw new Error("Query encoding ran before expansion admission");
    });
    onTestFinished(() => encode.mockRestore());

    await expect(
      perform(page, parsed.actions[0]!, resolved(parsed)),
    ).rejects.toThrow("serialization allowance");
    expect(encode).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  },
);

it("preserves goto form query normalization, Unicode, replacement characters and the fragment", async () => {
  const parsed = scenario([
    {
      ...gotoStep(`${ORIGIN}/items?literal=a%20b#kept`),
      destination: {
        url: `${ORIGIN}/items?literal=a%20b#kept`,
        query: [
          {
            name: "q",
            value: { source: "literal", value: "a b私😀!~'\ud800" },
          },
        ],
      },
    },
  ]);
  const goto = vi.fn(async () => null);
  await perform(
    { goto } as unknown as Page,
    parsed.actions[0]!,
    resolved(parsed),
  );
  expect(goto).toHaveBeenCalledWith(
    `${ORIGIN}/items?literal=a+b&q=a+b%E7%A7%81%F0%9F%98%80%21%7E%27%EF%BF%BD#kept`,
    expect.anything(),
  );
});

it("refuses repeated saved URL expansion before browser navigation", async () => {
  const parsed = scenario([
    requestStep({ save: [{ name: "large", json_pointer: "/value" }] }),
    {
      step_id: "open",
      action: "goto",
      destination: { url: `${ORIGIN}/` + "{saved:large}".repeat(1000) },
      wait_until: "load",
    },
  ]);
  const secrets = resolved(parsed);
  secrets.save("source.large", "large", "x".repeat(3_000_000), false);
  const goto = vi.fn();
  await expect(
    perform({ goto } as unknown as Page, parsed.actions[1]!, secrets),
  ).rejects.toThrow("serialization allowance");
  expect(goto).not.toHaveBeenCalled();
});

it.each([
  ["/api\\items/{*}", "/api/items/42"],
  ["/api/unused/../items/{*}", "/api/items/42"],
  ["/api/unused/%2e%2e/items/{*}", "/api/items/42"],
  ["/api/%7B*%7D", "/api/%7B*%7D", "/api/other"],
  ["/~rea-wildcard~/items/{*}", "/~rea-wildcard~/items/42", "/other/items/42"],
] as const)(
  "binds only the response named by normalized path %s",
  async (pattern, selected, excluded?: string) => {
    const parsed = clickSaving(pattern);
    const matching = {
      method: "POST",
      url: ORIGIN + selected,
      status: 201,
      body: '{"id":"42"}',
    };
    const { page, reads } = uiPage([
      ...(excluded === undefined
        ? []
        : [{ ...matching, url: ORIGIN + excluded, body: '{"id":"other"}' }]),
      matching,
    ]);
    const secrets = resolved(parsed);
    await perform(page, parsed.actions[0]!, secrets);
    expect(secrets.savedValue("item")).toBe("42");
    expect(reads.count).toBe(1);
  },
);

it("redacts a saved secret as a parsed URL query spells it", () => {
  const secrets = resolved(scenario([requestStep({})]));
  secrets.save("create.token", "token", "ab'cd~ef", true);
  const sent = new URL(
    `${ORIGIN}/api/items?token=${encodeURIComponent("ab'cd~ef")}`,
  ).href;
  expect(sent).toContain("ab%27cd~ef");
  expect(secrets.redact(sent)).toBe(
    `${ORIGIN}/api/items?token=[REDACTED:page:create.token]`,
  );
});
