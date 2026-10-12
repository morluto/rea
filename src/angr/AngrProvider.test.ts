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
  it("admits headered executables and declines slices, raw and DOS inputs", () => {
    const provider = configured();
    expect(
      provider.inspectTargetSupport({ ...identity, format: "elf" }),
    ).toMatchObject({ status: "supported" });
    const unsupported: readonly [BinaryTarget, string][] = [
      [
        {
          ...identity,
          format: "raw-binary",
          entryPoint: "0x8000000",
          entryPointSource: "0x8000000",
        },
        "target_format_unsupported",
      ],
      [{ ...identity, format: "dos-com" }, "target_format_unsupported"],
      [
        {
          ...identity,
          format: "mach-o-universal",
          universalSlice: { offset: 0, size: 1 },
        },
        "target_format_unsupported",
      ],
      [
        {
          path: "/tmp/target.i64",
          sha256: "b".repeat(64),
          kind: "database",
          format: "analysis-database",
        },
        "target_kind_unsupported",
      ],
    ];
    for (const [target, code] of unsupported)
      expect(provider.inspectTargetSupport(target)).toMatchObject({
        status: "unsupported",
        code,
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
