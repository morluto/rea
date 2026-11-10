import { describe, expect, it } from "vitest";

import { PRODUCT_IDENTITY } from "../identity.js";
import {
  announceAnalysisRuntimeReady,
  announceDeferredStdioStartup,
  type AnalysisRuntimeAnnouncement,
} from "./startupAnnouncement.js";

/** Collect what a banner wrote instead of printing it. */
const sink = (): { lines: string[]; sink: (text: string) => void } => {
  const lines: string[] = [];
  return { lines, sink: (text) => lines.push(text) };
};

const VERSION = PRODUCT_IDENTITY.packageVersion;

describe("MCP startup banners", () => {
  it("leads with the project tag so it reads beside other servers' banners", () => {
    const { lines, sink: bannerSink } = sink();
    announceDeferredStdioStartup(bannerSink, {
      profile: "full",
      toolCount: 137,
    });
    expect(lines).toEqual([
      `[rea] MCP server ready — REA ${VERSION}, 137 tools, stdio (analysis runtime deferred)\n`,
    ]);
  });

  it("states the hot/cold catalog instead of a count it does not serve", () => {
    const { lines, sink: bannerSink } = sink();
    announceDeferredStdioStartup(bannerSink, { profile: "hot-cold" });
    expect(lines).toEqual([
      `[rea] MCP server ready — REA ${VERSION}, hot tools plus discovery, stdio (analysis runtime deferred)\n`,
    ]);
  });

  it("reports the optional tools and providers one runtime detected", () => {
    const { lines, sink: bannerSink } = sink();
    announceAnalysisRuntimeReady(bannerSink, {
      transport: "streamable-http",
      availability: {
        optionalFeatures: {
          packetCaptureEnabled: true,
          signalRecordingEnabled: false,
          wasmArtifactEnabled: true,
        },
      },
      providers: { browserObservation: {} as never },
      providerLoadFailures: {
        browserScenarioCapture: {
          providerId: "browserScenarioCapture",
          reason: "module unavailable",
        },
      },
    });
    // Disabled and absent facts stay out of the line rather than being
    // reported as detected.
    expect(lines).toEqual([
      "[rea] MCP analysis runtime ready — streamable-http, optional tools: packetCaptureEnabled, wasmArtifactEnabled; providers: browserObservation; failed: browserScenarioCapture\n",
    ]);
  });

  it("names an empty detection list instead of trailing off", () => {
    const { lines, sink: bannerSink } = sink();
    const announcement: AnalysisRuntimeAnnouncement = {
      transport: "stdio",
      availability: {},
      providers: {},
      providerLoadFailures: {},
    };
    announceAnalysisRuntimeReady(bannerSink, announcement);
    expect(lines).toEqual([
      "[rea] MCP analysis runtime ready — stdio, optional tools: none; providers: none; failed: none\n",
    ]);
  });

  it("writes the banner without consulting a log level", () => {
    // A banner is not a log record: it is the one thing a client host shows, so
    // it is written whatever REA_LOG_LEVEL says, as the sibling servers do.
    const { lines, sink: bannerSink } = sink();
    announceDeferredStdioStartup(bannerSink, { profile: "full", toolCount: 3 });
    expect(lines).toHaveLength(1);
  });
});
