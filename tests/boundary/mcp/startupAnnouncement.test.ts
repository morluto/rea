import pino, { type LevelWithSilent } from "pino";
import { expect, it } from "vitest";

import { createManagedBinarySession } from "../../../src/composition/binary.js";
import { startMcpTransport } from "../../../src/main/transport.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";

const RUNTIME_READY = "[rea] MCP analysis runtime ready — ";

interface StartedTransport {
  readonly banner: string[];
  readonly factoryCalls: () => number;
  readonly close: () => Promise<void>;
}

/** Start one transport whose SDK creates `servers` discovery instances. */
const startOneTransport = async (
  servers: number,
  options: {
    readonly level: LevelWithSilent;
    readonly transport?: "stdio" | "http";
    readonly environment?: Readonly<NodeJS.ProcessEnv>;
    readonly loadOptionalProviders?: () => Promise<{
      readonly optionalProviderLoadFailures?: Readonly<
        Record<string, { readonly providerId: string; readonly reason: string }>
      >;
    }>;
  },
): Promise<StartedTransport> => {
  const banner: string[] = [];
  let factoryCalls = 0;
  const session = createManagedBinarySession();
  const started = await startMcpTransport(
    {
      env: {},
      ...(options.transport === undefined
        ? {}
        : { transport: options.transport }),
      serve: async (factory) => {
        for (let index = 0; index < servers; index += 1) {
          factoryCalls += 1;
          await factory({ era: "modern" });
        }
        return { close: async () => undefined };
      },
      writeStderr: (text) => banner.push(text),
      setExitCode: () => undefined,
      registerShutdown: () => () => undefined,
    },
    session,
    {
      logger: pino({ level: "silent" }),
      serverLogger: pino({ level: options.level }),
      environment: options.environment ?? {},
      delivery: createToolResultDelivery(undefined),
      loadOptionalProviders:
        options.loadOptionalProviders ?? (async () => ({})),
    },
  );
  if (!started.ok) throw new Error("Expected an admitted transport");
  return {
    banner,
    factoryCalls: () => factoryCalls,
    close: async () => {
      await started.handle.close();
      await started.closeAndroid();
      await started.closeOptionalProviders();
      await session.close();
    },
  };
};

it("announces the analysis runtime once when the SDK creates several servers", async () => {
  const started = await startOneTransport(3, {
    level: "warn",
    // An absolute configuration enables its capability without probing the host.
    environment: { REA_WABT_BIN_DIRECTORY: "/opt/wabt/bin" },
  });
  try {
    expect(started.factoryCalls()).toBe(3);
    expect(started.banner).toHaveLength(1);
    const [line = ""] = started.banner;
    expect(line.startsWith(RUNTIME_READY)).toBe(true);
    expect(line.endsWith("\n")).toBe(true);
    // Detection comes from the composed capability facts, not a second probe:
    // an absolute configuration makes that capability enabled, an unset one does not.
    expect(line).toContain("wasmArtifactEnabled");
    for (const unconfigured of [
      "signalRecordingEnabled",
      "firmwareInspectionEnabled",
      "javascriptRecoveryEnabled",
      "webModuleResolutionEnabled",
    ])
      expect(line).not.toContain(unconfigured);
    expect(line).toContain("providers: none; failed: none");
  } finally {
    await started.close();
  }
});

it("labels the listener transport it was started for", async () => {
  const started = await startOneTransport(1, {
    level: "warn",
    transport: "http",
  });
  try {
    expect(started.banner).toHaveLength(1);
    expect(
      started.banner[0]?.startsWith(
        `${RUNTIME_READY}streamable-http, optional tools: `,
      ),
    ).toBe(true);
  } finally {
    await started.close();
  }
});

it("announces even when the host configured silent logging", async () => {
  const started = await startOneTransport(1, { level: "silent" });
  try {
    expect(started.banner).toHaveLength(1);
    expect(started.banner[0]?.startsWith(RUNTIME_READY)).toBe(true);
  } finally {
    await started.close();
  }
});

it("reports a provider whose module failed to load beside the ones that loaded", async () => {
  const started = await startOneTransport(1, {
    level: "info",
    loadOptionalProviders: async () => ({
      optionalProviderLoadFailures: {
        browserScenarioCapture: {
          providerId: "browserScenarioCapture",
          reason: "module unavailable",
        },
      },
    }),
  });
  try {
    const [line = ""] = started.banner;
    expect(line).toContain("providers: none; failed: browserScenarioCapture");
  } finally {
    await started.close();
  }
});
