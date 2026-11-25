import { expect, onTestFinished } from "vitest";
import { z } from "zod";

import { webObservationSessionSchema } from "../../src/domain/browserSession.js";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { startFakeCdpBrowser } from "../fixtures/fakeCdpBrowser.js";
import { cliTest } from "../support/cli/cliFixture.js";

const startLifecycleBrowser = () =>
  startFakeCdpBrowser({
    eventsBeforeReply: [
      "Performance.getMetrics",
      "Page.setLifecycleEventsEnabled",
    ],
    commandResult: ({ method }) => {
      if (method === "Performance.enable") return {};
      if (method === "Performance.getMetrics")
        return { metrics: [{ name: "Timestamp", value: 20 }] };
      return undefined;
    },
    commandEvents: ({ method, sessionId }, origin) => {
      const milestone = (loaderId: string, timestamp: number | string) => ({
        method: "Page.lifecycleEvent",
        sessionId,
        params: { frameId: "frame-main", loaderId, name: "load", timestamp },
      });
      if (method === "Performance.getMetrics")
        return [
          milestone("loader-before-window", 19),
          {
            method: "Page.navigatedWithinDocument",
            sessionId,
            params: {
              frameId: "frame-main",
              url: `${origin}#during-clock-response`,
              navigationType: "historyApi",
            },
          },
        ];
      if (method === "Page.setLifecycleEventsEnabled")
        return [
          milestone("loader-before-window-replayed-after-arm", 19),
          milestone("loader-current-window", 21),
          milestone("loader-malformed-clock", "21"),
          {
            method: "Network.requestWillBeSent",
            sessionId,
            params: {
              requestId: "redirect-chain",
              frameId: "frame-main",
              loaderId: "redirect-loader",
              type: "Document",
              timestamp: 22,
              request: { url: `${origin}/after`, method: "GET" },
              redirectResponse: {
                url: `${origin}/before?token=visible`,
                status: 302,
                headers: { Authorization: "discard-redirect-header" },
                body: "discard-redirect-body",
              },
            },
          },
          {
            method: "Page.frameNavigated",
            sessionId,
            params: {
              type: "BackForwardCacheRestore",
              frame: {
                id: "frame-main",
                loaderId: "restored-loader",
                url: `${origin}/app`,
                urlFragment: "#restored",
              },
            },
          },
        ];
      return undefined;
    },
  });

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains in-window navigation, redirects, and lifecycle evidence through %s",
  async (surface, { cli }) => {
    const browser = await startLifecycleBrowser();
    onTestFinished(() => browser.close());

    let evidence: unknown;
    if (surface === "CLI") {
      const response = await cli.run({
        arguments: [
          "observe-web-session",
          browser.endpoint,
          "allowed-page",
          "--allowed-origins",
          browser.allowedOrigin,
          "--observation-ms",
          "5",
          "--json",
        ],
      });
      expect(response.exitCode, response.stderr).toBe(0);
      evidence = response.json;
    } else {
      const { call } = await connectLocalToolsMcp();
      const response = await call("observe_web_session", {
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 5,
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      evidence = response.structuredContent;
    }

    expect(JSON.stringify(evidence)).not.toContain("discard-redirect-");
    const contract = toolContract("observe_web_session");
    const sourceEvidence = contract.outputSchema.parse(evidence);
    const normalized = z
      .object({ normalized_result: webObservationSessionSchema })
      .parse(sourceEvidence).normalized_result;
    expect(
      normalized.timeline.filter(({ type }) => type === "lifecycle"),
    ).toEqual([
      expect.objectContaining({
        loader_id: "loader-current-window",
        timestamp: 21,
      }),
    ]);
    expect(normalized.timeline).toContainEqual(
      expect.objectContaining({
        type: "same_document_navigation",
        url: `${browser.allowedOrigin}#during-clock-response`,
        timestamp: null,
      }),
    );
    expect(normalized.completeness.excluded).toContainEqual({
      section: "timeline",
      reason: "invalid_protocol_value",
      count: 1,
    });
    expect(normalized.timeline).toContainEqual(
      expect.objectContaining({
        type: "navigation_committed",
        frame_id: "frame-main",
        loader_id: "restored-loader",
        url: `${browser.allowedOrigin}/app#restored`,
        detail: "backforwardcacherestore",
      }),
    );
    expect(
      normalized.timeline.filter(({ type }) => type === "redirect"),
    ).toEqual([
      expect.objectContaining({
        frame_id: "frame-main",
        loader_id: "redirect-loader",
        request_id: "redirect-chain",
        timestamp: 22,
        url: `${browser.allowedOrigin}/after`,
        destination_scope: "approved",
        redirect_response: {
          url: `${browser.allowedOrigin}/before?token=visible`,
          status: 302,
          scope: "approved",
        },
      }),
    ]);
    if (surface === "CLI") {
      const index = normalized.timeline.findIndex(
        ({ type }) => type === "redirect",
      );
      const redirect = normalized.timeline[index]!;
      for (const altered of [
        { ...redirect, redirect_response: undefined },
        { ...redirect, type: "lifecycle" as const },
      ]) {
        const timeline = normalized.timeline.with(index, altered);
        expect(
          webObservationSessionSchema.safeParse({ ...normalized, timeline }),
        ).toMatchObject({
          success: false,
          error: {
            issues: [
              expect.objectContaining({
                path: ["timeline", index, "redirect_response"],
                message:
                  "redirect_response is present exactly on redirect events.",
              }),
            ],
          },
        });
      }
    }
    expect(normalized.limitations).toContainEqual(
      expect.stringMatching(
        /Buffered events.*unknown timing.*context only.*do not establish.*observation window/iu,
      ),
    );
    expect(browser.commands).toContainEqual(
      expect.objectContaining({
        method: "Performance.enable",
        params: { timeDomain: "timeTicks" },
      }),
    );
  },
);
