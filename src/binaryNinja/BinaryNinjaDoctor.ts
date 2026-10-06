import type { DoctorProviderInspection } from "../application/Doctor.js";
import { parseConfig } from "../config.js";
import { BinaryNinjaProvider } from "./BinaryNinjaProvider.js";
import { BinaryNinjaMcp, redactValue } from "./BinaryNinjaMcp.js";

/** Probe the configured MCP connection and tool inventory without opening a binary. */
export const inspectSystemBinaryNinjaProvider =
  async (): Promise<DoctorProviderInspection> => {
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        key.startsWith("REA_BINARY_NINJA_"),
      ),
    );
    const parsed = parseConfig(environment);
    const configured =
      environment.REA_BINARY_NINJA_MCP_URL !== undefined ||
      environment.REA_BINARY_NINJA_MCP_COMMAND !== undefined;
    const base = {
      id: "binary-ninja",
      configured,
      providerVersion: null,
      registrationEnvironment: {},
    };
    const failed = (
      code: string,
      detail: string,
    ): DoctorProviderInspection => ({
      ...base,
      available: false,
      checks: [
        {
          name: "mcp",
          ok: false,
          code,
          detail,
          classification: configured
            ? "config_drift"
            : "missing_analysis_engine",
          remediation:
            "Configure the built-in Binary Ninja MCP server using docs/binary-ninja.md, then rerun rea doctor --provider binary-ninja.",
        },
      ],
    });
    if (!parsed.ok)
      return failed("invalid_configuration", parsed.error.message);
    const availability = new BinaryNinjaProvider(
      parsed.value,
    ).inspectAvailability();
    if (availability.status === "unavailable")
      return failed(availability.code, availability.reason);
    const config = parsed.value.binaryNinjaMcp;
    if (config === undefined)
      return failed(
        "not_configured",
        "No Binary Ninja MCP connection is configured",
      );
    const mcp = new BinaryNinjaMcp({
      ...config,
      timeoutMs: Math.min(config.timeoutMs, 10_000),
    });
    try {
      await mcp.connect();
      return {
        ...base,
        available: true,
        providerVersion: mcp.client.getServerVersion()?.version ?? null,
        checks: [
          {
            name: "mcp",
            ok: true,
            code: null,
            detail: `Connected to the built-in MCP server; tool roles: ${Object.keys(mcp.inventory()).join(", ")}. No target was opened.`,
            classification: "config_drift",
            remediation: null,
          },
        ],
      };
    } catch (cause: unknown) {
      const reason = redactValue(
        cause instanceof Error ? cause.message : String(cause),
        config.token,
      );
      return failed(
        "connection_failed",
        typeof reason === "string" ? reason : "MCP connection failed",
      );
    } finally {
      await mcp.close();
    }
  };
