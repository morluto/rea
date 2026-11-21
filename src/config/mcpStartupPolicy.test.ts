import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { describe, expect, it } from "vitest";

import { parseClientConfiguration } from "../application/ClientConfigurationDocument.js";
import { clientRegistrationEnvironmentDetails } from "../application/ClientRegistrationEnvironment.js";
import { explicitSetupRegistrationEnvironment } from "../application/SetupRegistrationEnvironment.js";
import {
  mcpProviderDeadlineAllowanceMs,
  recommendedMcpToolTimeoutSeconds,
} from "./mcpStartupPolicy.js";

const inputs = {
  ghidraStartupTimeoutMs: 330_000,
  hopperStartupTimeoutMs: 120_000,
} as const;

describe("MCP tool deadline allowance for a Ghidra decompile limit", () => {
  it.each([
    ["ghidra", 930_000],
    ["auto", 930_000],
    ["hopper", 120_000],
  ] as const)(
    "allows %s cold startup plus the selected decompile limit",
    (analysisProvider, expected) => {
      expect(
        mcpProviderDeadlineAllowanceMs({
          ...inputs,
          analysisProvider,
          ghidraDecompileTimeoutMs: 600_000,
        }),
      ).toBe(expected);
    },
  );

  it("keeps the startup-only allowance when no decompile limit is set", () => {
    const allowance = { ...inputs, analysisProvider: "ghidra" } as const;
    expect(mcpProviderDeadlineAllowanceMs(allowance)).toBe(330_000);
    expect(recommendedMcpToolTimeoutSeconds(allowance)).toBe(450);
  });

  it("derives the registration allowance from REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS", () => {
    const details = clientRegistrationEnvironmentDetails(
      parseClientConfiguration(
        JSON.stringify({
          mcpServers: {
            rea: {
              command: "rea",
              args: ["mcp"],
              env: {
                REA_ANALYSIS_PROVIDER: "ghidra",
                REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS: "600",
              },
            },
          },
        }),
        "json",
      ),
      undefined,
      HOST_PLATFORM.platform,
    );
    if (!details.ok) throw details.error;
    expect(details.value.timeoutInputs).toMatchObject({
      analysisProvider: "ghidra",
      ghidraDecompileTimeoutMs: 600_000,
    });
    // 330 s default startup + 600 s limit + 120 s operation headroom.
    const timeoutInputs = details.value.timeoutInputs;
    if (timeoutInputs === undefined)
      throw new Error("Expected resolved decompile timeout inputs");
    expect(recommendedMcpToolTimeoutSeconds(timeoutInputs)).toBe(1050);
  });

  it("derives the allowance from the spelling the child receives on Windows", () => {
    // Windows names are case-insensitive, so a differently-cased registration setting is the same
    // setting and the child applies it. Deriving these facts from the recorded spelling would
    // report the default allowance for a timeout the child really enforces.
    const at = (
      environment: Readonly<Record<string, string>>,
      platform: NodeJS.Platform,
    ) => {
      const details = clientRegistrationEnvironmentDetails(
        parseClientConfiguration(
          JSON.stringify({
            mcpServers: {
              rea: { command: "rea", args: ["mcp"], env: environment },
            },
          }),
          "json",
        ),
        undefined,
        platform,
        {},
        "effective",
      );
      if (!details.ok) throw details.error;
      return details.value;
    };

    const folded = at({ rea_hopper_startup_timeout_ms: "2700000" }, "win32");
    expect(folded.timeoutInputs).toMatchObject({
      hopperStartupTimeoutMs: 2_700_000,
    });
    // The file keeps the caller's spelling even though the derived fact is folded.
    expect(Object.keys(folded.values)).toEqual([
      "rea_hopper_startup_timeout_ms",
    ]);

    const timeoutInputs = folded.timeoutInputs;
    if (timeoutInputs === undefined)
      throw new Error("Expected resolved timeout inputs");
    // 120 s headroom over the 2700 s startup allowance the child enforces.
    expect(recommendedMcpToolTimeoutSeconds(timeoutInputs)).toBe(2_820);

    // The other three forwarded facts fold the same way.
    expect(
      at({ rea_ghidra_startup_timeout_ms: "600000" }, "win32").timeoutInputs,
    ).toMatchObject({ ghidraStartupTimeoutMs: 600_000 });
    expect(
      at({ rea_ghidra_decompile_timeout_seconds: "120" }, "win32")
        .timeoutInputs,
    ).toMatchObject({ ghidraDecompileTimeoutMs: 120_000 });
    expect(
      at({ rea_jeb_mcp_timeout_ms: "600000" }, "win32").timeoutInputs,
    ).toMatchObject({ jebMcpTimeoutMs: 600_000 });

    // POSIX names are case-sensitive, so a lower-case spelling stays a different variable.
    expect(
      at({ rea_hopper_startup_timeout_ms: "2700000" }, "linux").timeoutInputs,
    ).toMatchObject({ hopperStartupTimeoutMs: 120_000 });
  });
  it("forwards selected launch and response limits without copying transport credentials or unrelated settings", () => {
    expect(
      explicitSetupRegistrationEnvironment({
        REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS: "600",
        REA_ASAR_MAX_HEADER_BYTES: "33554432",
        REA_MCP_MAX_RESPONSE_BYTES: "20971520",
        REA_TOKEN: "transport-only",
        UNRELATED: "dropped",
      }),
    ).toEqual({
      REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS: "600",
      REA_ASAR_MAX_HEADER_BYTES: "33554432",
      REA_MCP_MAX_RESPONSE_BYTES: "20971520",
    });
  });
});
