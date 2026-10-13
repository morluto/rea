import { describe, expect, it } from "vitest";

import { parseConfig } from "../config/parseConfig.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { AngrProvider } from "./AngrProvider.js";

const configured = () => {
  const config = parseConfig({ REA_ANGR_PYTHON: process.execPath });
  if (!config.ok) throw config.error;
  return new AngrProvider(config.value, {});
};
const identity = {
  path: "/tmp/target",
  sha256: "a".repeat(64),
  kind: "executable",
  architecture: "x86_64",
  availableArchitectures: ["x86_64"],
} as const;

describe("angr provider discovery", () => {
  it("reports configuration state without starting a process", () => {
    const unconfigured = parseConfig({});
    if (!unconfigured.ok) throw unconfigured.error;
    expect(
      new AngrProvider(unconfigured.value, {}).inspectAvailability(),
    ).toMatchObject({ status: "unavailable", code: "not_configured" });
    const missing = parseConfig({ REA_ANGR_PYTHON: "/nonexistent/python" });
    if (!missing.ok) throw missing.error;
    expect(
      new AngrProvider(missing.value, {}).inspectAvailability(),
    ).toMatchObject({ status: "unavailable", code: "executable_missing" });
    expect(configured().inspectAvailability()).toMatchObject({
      status: "available",
      diagnostics: {
        mode: "headless",
        transport: "stdio",
        live_connection_probed: false,
      },
    });
    expect(
      configured()
        .capabilities()
        .every(
          ({ available, effects, provider }) =>
            available && effects.launchesProcess && provider.id === "angr",
        ),
    ).toBe(true);
  });
  it("admits every executable format and declines non-executable kinds", () => {
    const provider = configured();
    const executables: readonly BinaryTarget[] = [
      { ...identity, format: "elf" },
      { ...identity, format: "dos-com" },
      {
        ...identity,
        format: "raw-binary",
        entryPoint: "0x8000000",
        entryPointSource: "0x8000000",
      },
      {
        ...identity,
        format: "mach-o-universal",
        universalSlice: { offset: 0, size: 1 },
      },
    ];
    for (const target of executables)
      expect(provider.inspectTargetSupport(target)).toMatchObject({
        status: "supported",
      });
    expect(
      provider.inspectTargetSupport({
        path: "/tmp/target.i64",
        sha256: "b".repeat(64),
        kind: "database",
        format: "analysis-database",
      }),
    ).toMatchObject({ status: "unsupported", code: "target_kind_unsupported" });
  });
  it("derives process and network effects from the transport, not the mode", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "rea-angr-provider-"));
    try {
      const path = join(root, "mcp.json");
      await writeFile(
        path,
        JSON.stringify({ command: "proxy", args: [], mode: "attached" }),
      );
      const config = parseConfig({ REA_ANGR_MCP_CONFIG: path });
      if (!config.ok) throw config.error;
      const [capability] = new AngrProvider(config.value, {}).capabilities();
      expect(capability?.effects).toMatchObject({
        launchesProcess: true,
        mayWriteFilesystem: true,
        mayAccessNetwork: true,
      });
      await writeFile(
        path,
        JSON.stringify({ url: "http://127.0.0.1:8000/mcp" }),
      );
      const http = parseConfig({ REA_ANGR_MCP_CONFIG: path });
      if (!http.ok) throw http.error;
      const [remote] = new AngrProvider(http.value, {}).capabilities();
      expect(remote?.effects).toMatchObject({
        launchesProcess: false,
        mayWriteFilesystem: false,
        mayAccessNetwork: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("commits a live profile that never persists the registration itself", async () => {
    const resolution = await configured().resolveAnalysisProfile({
      ...identity,
      format: "elf",
    });
    if (!resolution.ok) throw resolution.error;
    expect(resolution.value.profile?.parameters).toMatchObject({
      version_scope: "rea-angr-adapter",
      mode: "headless",
      transport: "stdio",
      cache_policy: "live",
      auto_load_libs: false,
    });
    expect(JSON.stringify(resolution)).not.toContain(process.execPath);
  });
});
