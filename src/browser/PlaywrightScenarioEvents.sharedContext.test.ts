import { EventEmitter } from "node:events";
import type { Page } from "playwright-core";
import { expect, it } from "vitest";

import { browserScenarioSchema } from "../domain/browserScenario.js";
import { resolveScenarioSecrets } from "../../tests/fixtures/browserScenarioSecrets.js";
import { PlaywrightScenarioEvents } from "./PlaywrightScenarioEvents.js";

it("reports opaque request redirects as a network coverage gap only when network was selected", () => {
  const page = new EventEmitter() as unknown as Page;
  const context = new EventEmitter();
  const scenario = browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: "/opt/chromium" },
    start_url: { url: "https://app.example.test/" },
    actions: [{ step_id: "wait", action: "wait_for_timeout", duration_ms: 1 }],
  });
  const secrets = resolveScenarioSecrets(scenario, {});
  const create = (enabled: Set<"network">) =>
    new PlaywrightScenarioEvents({
      page,
      context: context as never,
      ownsContext: true,
      enabled,
      secrets,
    });
  const network = create(new Set(["network"]));
  const none = create(new Set());
  expect(network.limitations()).toEqual([]);
  network.opaqueRequestRedirect();
  none.opaqueRequestRedirect();
  expect(network.limitations()).toEqual([
    expect.stringContaining("response status and Location may be unavailable"),
  ]);
  expect(none.limitations()).toEqual([]);
});

it.each(["shared", "owned"])(
  "captures only in-scope activity and releases its listeners in %s contexts",
  async (mode) => {
    const ownsContext = mode === "owned";
    const context = new EventEmitter();
    const page = new EventEmitter();
    const descendant = (url: string) =>
      Object.assign(new EventEmitter(), { url: () => url });
    const popup = descendant("https://app.example.test/popup");
    const unrelated = descendant("https://app.example.test/popup");
    const socket = descendant("wss://app.example.test/socket");
    const worker = descendant("https://app.example.test/worker.js");
    const scenario = browserScenarioSchema.parse({
      browser: { mode: "launch", executable_path: "/opt/chromium" },
      start_url: { url: "https://app.example.test/" },
      actions: [
        { step_id: "wait", action: "wait_for_timeout", duration_ms: 1 },
      ],
    });
    const events = new PlaywrightScenarioEvents({
      page: page as unknown as Page,
      context: context as never,
      ownsContext,
      enabled: new Set([
        "console",
        "popups",
        "network",
        "workers",
        "websockets",
      ]),
      secrets: resolveScenarioSecrets(scenario, {}),
    });
    const outsideListener = () => undefined;
    page.on("console", outsideListener);
    expect(context.listenerCount("page")).toBe(ownsContext ? 1 : 0);
    context.emit("page", popup);
    page.emit("popup", popup);
    popup.emit("websocket", socket);
    popup.emit("worker", worker);

    for (const [type, owner] of [
      ["root", page],
      ["descendant", popup],
      ["other-tab", unrelated],
      ["unknown-frame", undefined],
    ] as const)
      context.emit("request", {
        frame: () => {
          if (owner === undefined)
            throw new Error("Navigation frame unavailable");
          return { page: () => owner };
        },
        url: () => "https://app.example.test/shared",
        method: () => "GET",
        resourceType: () => type,
        headers: () => ({}),
        redirectedFrom: () => null,
      });

    const captured = events.result().items;
    expect(captured.filter(({ kind }) => kind === "popup-opened")).toHaveLength(
      1,
    );
    expect(
      captured
        .filter((item) => item.kind === "request")
        .map(({ resource_type }) => resource_type),
    ).toEqual(
      ownsContext
        ? ["root", "descendant", "other-tab", "unknown-frame"]
        : ["root", "descendant"],
    );
    if (!ownsContext)
      expect(events.limitations()).toContainEqual(
        expect.stringContaining("without a known root or descendant"),
      );
    expect(page.listenerCount("console")).toBe(2);
    expect(popup.listenerCount("console")).toBe(1);
    expect(socket.eventNames()).toEqual([
      "framesent",
      "framereceived",
      "close",
    ]);
    expect(worker.eventNames()).toEqual(["close"]);

    await events.finish();
    expect(page.eventNames()).toEqual(["console"]);
    expect(page.listeners("console")).toEqual([outsideListener]);
    for (const source of [context, popup, socket, worker])
      expect(source.eventNames()).toEqual([]);
  },
);

it.each([false, true])(
  "keeps requested popup page errors when popup lifecycle metadata exceeds the event budget (lifecycle selected: %s)",
  async (lifecycle) => {
    const page = new EventEmitter();
    let popupUrl = `https://app.example.test/${"x".repeat(5000)}`;
    const popup = Object.assign(new EventEmitter(), {
      url: () => popupUrl,
    });
    const scenario = browserScenarioSchema.parse({
      browser: { mode: "launch", executable_path: "/fixture/browser" },
      start_url: { url: "https://app.example.test/" },
      actions: [
        { step_id: "wait", action: "wait_for_timeout", duration_ms: 1 },
      ],
      capture: { limits: { max_event_allocation_bytes: 20_000 } },
    });
    const events = new PlaywrightScenarioEvents({
      page: page as unknown as Page,
      enabled: lifecycle
        ? new Set(["page-errors", "popups"])
        : new Set(["page-errors"]),
      limits: scenario.capture.limits,
      secrets: resolveScenarioSecrets(scenario, {}),
    });
    page.emit("popup", popup);
    const error = new Error("small popup application failure");
    error.stack = "";
    popup.emit("pageerror", error);
    expect(events.result().items).toEqual([
      expect.objectContaining({ kind: "page-error", message: error.message }),
    ]);
    expect(events.result().omissions.by_kind).toEqual(
      lifecycle
        ? [
            {
              kind: "popup-opened",
              count: 1,
              reasons: ["max-event-allocation-bytes"],
            },
          ]
        : [],
    );
    popupUrl = "https://app.example.test/closed";
    popup.emit("close");
    expect(events.result().items.map(({ kind }) => kind)).toEqual(
      lifecycle ? ["page-error", "popup-closed"] : ["page-error"],
    );
    expect(popup.listenerCount("pageerror")).toBe(0);
    await events.finish();
    expect(popup.listenerCount("close")).toBe(0);
  },
);
