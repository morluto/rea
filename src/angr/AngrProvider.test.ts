import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

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
  it("reports configuration state without starting a process", async () => {
    const unconfigured = parseConfig({});
    if (!unconfigured.ok) throw unconfigured.error;
    expect(
      await new AngrProvider(unconfigured.value, {}).inspectAvailability(),
    ).toMatchObject({ status: "unavailable", code: "not_configured" });
    const missing = parseConfig({ REA_ANGR_PYTHON: "/nonexistent/python" });
    if (!missing.ok) throw missing.error;
    expect(
      await new AngrProvider(missing.value, {}).inspectAvailability(),
    ).toMatchObject({ status: "unavailable", code: "executable_missing" });
    expect(await configured().inspectAvailability()).toMatchObject({
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
  it("admits supported executable inputs and declines unavailable slice selection", () => {
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
    ];
    for (const target of executables)
      expect(provider.inspectTargetSupport(target)).toMatchObject({
        status: "supported",
      });
    expect(
      provider.inspectTargetSupport({
        ...identity,
        format: "mach-o-universal",
        universalSlice: { offset: 0, size: 1 },
      }),
    ).toMatchObject({
      status: "unsupported",
      code: "target_format_unsupported",
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
    const root = await createTestTempDirectory("rea-angr-provider-");
    const path = join(root, "mcp.json");
    const effects = async () => {
      const config = parseConfig({ REA_ANGR_MCP_CONFIG: path });
      if (!config.ok) throw config.error;
      const snapshot = await new AngrProvider(
        config.value,
        {},
      ).inspectReadinessSnapshot();
      return snapshot.capabilities[0]?.effects;
    };
    await writeFile(
      path,
      JSON.stringify({ command: "proxy", args: [], mode: "attached" }),
    );
    expect(await effects()).toMatchObject({
      launchesProcess: true,
      mayWriteFilesystem: true,
      mayAccessNetwork: true,
    });
    await writeFile(path, JSON.stringify({ url: "http://127.0.0.1:8000/mcp" }));
    expect(await effects()).toMatchObject({
      launchesProcess: false,
      mayWriteFilesystem: false,
      mayAccessNetwork: true,
    });
  });
  it("declares every effect a registration could have before reading one", () => {
    const unconfigured = parseConfig({});
    if (!unconfigured.ok) throw unconfigured.error;
    expect(
      new AngrProvider(unconfigured.value, {})
        .capabilities()
        .every(
          ({ effects }) =>
            effects.launchesProcess &&
            effects.mayWriteFilesystem &&
            effects.mayAccessNetwork,
        ),
    ).toBe(true);
  });
  it("hands out clients only through the resolved binding", async () => {
    const target = { ...identity, format: "elf" } as const;
    const provider = configured();
    const resolution = await provider.resolveAnalysisProfile(target);
    if (!resolution.ok) throw resolution.error;
    const { profile, createClient } = resolution.value;
    if (profile === null || createClient === undefined)
      throw new Error("expected a bound profile");
    const unbound = await provider
      .createClient(target, profile)
      .execute("list_procedures", {});
    expect(unbound).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("selected profile binding") },
    });
    const mismatched = await createClient(
      { ...target, sha256: "c".repeat(64) },
      profile,
    ).execute("list_procedures", {});
    expect(mismatched).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining("different from the resolved"),
      },
    });
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
