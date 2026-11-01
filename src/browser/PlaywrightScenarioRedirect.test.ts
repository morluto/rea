import { EventEmitter } from "node:events";
import type { Page, Request } from "playwright-core";
import { describe, expect, it, vi } from "vitest";

import {
  observeScenarioRedirect,
  type ScenarioRedirectResponse,
} from "./PlaywrightScenarioRedirect.js";

const URL_ = "https://app.example.test/redirect";

class FakeSession extends EventEmitter {
  readonly send = vi.fn(async () => ({}));
  readonly detach = vi.fn(async () => {});
}

const fakeRequest = (url = URL_, method = "GET") =>
  ({ url: () => url, method: () => method }) as unknown as Request;

const setup = (session = new FakeSession()) => {
  const emitter = new EventEmitter();
  const page = Object.assign(emitter, {
    context: () => ({ newCDPSession: async () => session }),
  }) as unknown as Page;
  const responses: ScenarioRedirectResponse[] = [];
  return { page, emitter, session, responses };
};

const observe = (page: Page, responses: ScenarioRedirectResponse[]) =>
  observeScenarioRedirect({
    page,
    url: URL_,
    method: "GET",
    onResponse: (response) => responses.push(response),
  });

const dispatch = (session: FakeSession, requestId = "1.1"): void => {
  session.emit("Network.requestWillBeSent", {
    requestId,
    request: { url: URL_, method: "GET" },
  });
};

const answer = (
  session: FakeSession,
  statusCode: number,
  headers: Record<string, string>,
  requestId = "1.1",
): void => {
  session.emit("Network.responseReceivedExtraInfo", {
    requestId,
    statusCode,
    headers,
  });
};

describe("request step redirect observation", () => {
  it("presents the redirect the browser reported as the response Playwright withheld", async () => {
    const { page, emitter, session, responses } = setup();
    const observation = await observe(page, responses);
    expect(observation).toBeDefined();
    const request = fakeRequest();
    dispatch(session);
    emitter.emit("request", request);
    answer(session, 302, {
      Location: "/destination",
      "Set-Cookie": "a=1\nb=2",
      "X-Dup": "x\ny",
    });
    expect(observation!.delivered()).toBe(true);
    expect(responses).toHaveLength(1);
    const [response] = responses;
    expect(response!.request()).toBe(request);
    expect(response!.status()).toBe(302);
    expect(response!.url()).toBe(URL_);
    expect(response!.headers()).toEqual({
      location: "/destination",
      "set-cookie": "a=1\nb=2",
      "x-dup": "x, y",
    });
    await expect(response!.headersArray()).resolves.toEqual([
      { name: "Location", value: "/destination" },
      { name: "Set-Cookie", value: "a=1" },
      { name: "Set-Cookie", value: "b=2" },
      { name: "X-Dup", value: "x" },
      { name: "X-Dup", value: "y" },
    ]);
    await expect(response!.body()).rejects.toThrow("no readable body");
    await observation!.stop();
  });

  it("delivers once whichever of the request and the answer is reported first", async () => {
    const { page, emitter, session, responses } = setup();
    const observation = await observe(page, responses);
    dispatch(session);
    answer(session, 307, { location: "/next" });
    expect(responses).toHaveLength(0);
    const request = fakeRequest();
    emitter.emit("request", request);
    emitter.emit("request", request);
    expect(responses).toHaveLength(1);
    expect(observation!.delivered()).toBe(true);
    await observation!.stop();
  });

  it("ignores answers that are not redirects, belong to other requests, or lack a Location", async () => {
    const { page, emitter, session, responses } = setup();
    const observation = await observe(page, responses);
    dispatch(session);
    emitter.emit("request", fakeRequest());
    answer(session, 200, { location: "/x" });
    answer(session, 304, { etag: "v1" });
    // Fetch does not redirect on 300; its answer is an ordinary response.
    answer(session, 300, { location: "/choices" });
    answer(session, 302, {});
    answer(session, 302, { location: "/other" }, "9.9");
    expect(responses).toHaveLength(0);
    expect(observation!.delivered()).toBe(false);
    await observation!.stop();
  });
});

describe("request step redirect observation bounds", () => {
  it("does not recover an answer whose raw headers exceed the bound, and builds the header map once", async () => {
    const { page, emitter, session, responses } = setup();
    const observation = await observe(page, responses);
    dispatch(session);
    emitter.emit("request", fakeRequest());
    answer(session, 302, {
      location: "/destination",
      "x-large": "v\n".repeat(200 * 1024),
    });
    expect(responses).toHaveLength(0);
    expect(observation!.delivered()).toBe(false);
    // Few characters but many expanded entries is bounded separately.
    answer(session, 302, {
      location: "/destination",
      "x-many": "v\n".repeat(5_000),
    });
    expect(responses).toHaveLength(0);
    answer(session, 302, { location: "/destination" });
    expect(responses).toHaveLength(1);
    expect(responses[0]!.headers()).toBe(responses[0]!.headers());
    await observation!.stop();
  });

  it("does not attribute a redirect to either of two identical dispatches", async () => {
    const { page, emitter, session, responses } = setup();
    const observation = await observe(page, responses);
    dispatch(session, "1.1");
    dispatch(session, "1.2");
    const first = fakeRequest();
    emitter.emit("request", first);
    emitter.emit("request", fakeRequest());
    answer(session, 302, { location: "/destination" }, "1.1");
    expect(responses).toHaveLength(0);
    expect(observation!.delivered()).toBe(false);
    await observation!.stop();
  });

  it("declines malformed protocol events instead of throwing", async () => {
    const { page, emitter, session, responses } = setup();
    const observation = await observe(page, responses);
    emitter.emit("request", fakeRequest());
    for (const bad of [
      undefined,
      null,
      7,
      {},
      { requestId: "1.1" },
      { requestId: "1.1", request: 3 },
    ])
      expect(() =>
        session.emit("Network.requestWillBeSent", bad),
      ).not.toThrow();
    dispatch(session);
    for (const bad of [
      undefined,
      { requestId: "1.1" },
      { requestId: "1.1", statusCode: "302", headers: { location: "/x" } },
      { requestId: "1.1", statusCode: 302, headers: { location: 5 } },
      { requestId: "1.1", statusCode: 302, headers: null },
    ])
      expect(() =>
        session.emit("Network.responseReceivedExtraInfo", bad),
      ).not.toThrow();
    expect(responses).toHaveLength(0);
    expect(observation!.delivered()).toBe(false);
    await observation!.stop();
  });

  it("withdraws its claim when a second identical dispatch follows an early answer", async () => {
    const { page, emitter, session, responses } = setup();
    const observation = await observe(page, responses);
    dispatch(session, "1.1");
    emitter.emit("request", fakeRequest());
    answer(session, 302, { location: "/background" }, "1.1");
    expect(observation!.delivered()).toBe(true);
    dispatch(session, "1.2");
    expect(observation!.delivered()).toBe(false);
    // Later answers and dispatches cannot restore attribution.
    dispatch(session, "1.3");
    answer(session, 302, { location: "/later" }, "1.3");
    expect(responses).toHaveLength(1);
    expect(observation!.delivered()).toBe(false);
    await observation!.stop();
  });

  it("stops listening and detaches its session", async () => {
    const { page, emitter, session, responses } = setup();
    const observation = await observe(page, responses);
    await observation!.stop();
    expect(session.detach).toHaveBeenCalledOnce();
    dispatch(session);
    emitter.emit("request", fakeRequest());
    answer(session, 302, { location: "/destination" });
    expect(responses).toHaveLength(0);
  });

  it("reports no transport when the browser cannot provide one, and releases a session that attached late", async () => {
    const page = Object.assign(new EventEmitter(), {
      context: () => ({
        newCDPSession: async () => {
          throw new Error("not supported");
        },
      }),
    }) as unknown as Page;
    await expect(observe(page, [])).resolves.toBeUndefined();

    const session = new FakeSession();
    session.send.mockRejectedValueOnce(new Error("Network.enable failed"));
    const { page: enabling } = setup(session);
    await expect(observe(enabling, [])).resolves.toBeUndefined();
    expect(session.detach).toHaveBeenCalledOnce();
  });

  it("detaches a session that attaches after the bounded wait, without delivering anything", async () => {
    vi.useFakeTimers();
    try {
      const session = new FakeSession();
      let attach: (value: FakeSession) => void = () => {};
      const slow = new Promise<FakeSession>((resolve) => {
        attach = resolve;
      });
      const page = Object.assign(new EventEmitter(), {
        context: () => ({ newCDPSession: () => slow }),
      }) as unknown as Page;
      const responses: ScenarioRedirectResponse[] = [];
      const pending = observe(page, responses);
      await vi.advanceTimersByTimeAsync(2_500);
      await expect(pending).resolves.toBeUndefined();
      expect(session.detach).not.toHaveBeenCalled();
      attach(session);
      await vi.advanceTimersByTimeAsync(0);
      expect(session.detach).toHaveBeenCalledOnce();
      dispatch(session);
      answer(session, 302, { location: "/destination" });
      expect(responses).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
