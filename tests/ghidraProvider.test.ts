import { describe, expect, it, vi } from "vitest";

import { parseConfig } from "../src/config.js";
import type { BinaryTarget } from "../src/domain/binaryTarget.js";
import {
  GHIDRA_PROVIDER_IDENTITY,
  GHIDRA_PROVIDER_TOOL_CONTRACTS,
  GhidraProvider,
} from "../src/ghidra/GhidraProvider.js";
import type { GhidraInstallationHost } from "../src/ghidra/GhidraInstallation.js";
import { silentLogger } from "../src/logger.js";

const INSTALL = "/opt/ghidra_12.1.2_PUBLIC";
const installationHost = (): GhidraInstallationHost => ({
  readText: () => "application.version=12.1.2\n",
  executable: () => true,
  probeJava: () => ({
    version: "21.0.11",
    major: 21,
    home: "/usr/lib/jvm/jdk-21",
    bits: 64,
    jdk: true,
  }),
});

const provider = (host = installationHost()): GhidraProvider => {
  const config = parseConfig({ GHIDRA_INSTALL_DIR: INSTALL });
  if (!config.ok) throw config.error;
  return new GhidraProvider(config.value, silentLogger, host);
};

describe("Ghidra provider", () => {
  it("discovers the exact installation once without launching Ghidra", () => {
    const host = installationHost();
    const probe = vi.spyOn(host, "probeJava");
    const ghidra = provider(host);

    expect(ghidra.identity()).toEqual(GHIDRA_PROVIDER_IDENTITY);
    expect(ghidra.capabilities()).toBe(GHIDRA_PROVIDER_TOOL_CONTRACTS);
    expect(GHIDRA_PROVIDER_TOOL_CONTRACTS).toEqual([]);
    expect(Object.isFrozen(ghidra.capabilities())).toBe(true);
    expect(ghidra.inspectAvailability()).toMatchObject({
      status: "available",
      diagnostics: {
        install_dir: INSTALL,
        provider_version: "12.1.2",
        java_version: "21.0.11",
      },
    });
    expect(ghidra.inspectAvailability()).toMatchObject({ status: "available" });
    expect(probe).toHaveBeenCalledOnce();
  });

  it("separates target kind, format, and concrete architecture", () => {
    const ghidra = provider();
    expect(
      ghidra.inspectTargetSupport(executableTarget("elf", "x86_64")),
    ).toMatchObject({
      status: "supported",
    });
    expect(
      ghidra.inspectTargetSupport(executableTarget("pe", "arm64")),
    ).toMatchObject({
      status: "supported",
    });
    expect(
      ghidra.inspectTargetSupport({
        ...executableTarget("elf", "x86_64"),
        kind: "archive",
        format: "asar",
      }),
    ).toMatchObject({
      status: "unsupported",
      code: "target_kind_unsupported",
    });
    expect(
      ghidra.inspectTargetSupport(executableTarget("javascript", "x86_64")),
    ).toMatchObject({
      status: "unsupported",
      code: "target_format_unsupported",
    });
    expect(ghidra.inspectTargetSupport(executableTarget("elf"))).toMatchObject({
      status: "unsupported",
      code: "architecture_unsupported",
    });
  });

  it("commits exact provider, isolation, and resource semantics", async () => {
    const ghidra = provider();
    const resolved = await ghidra.resolveAnalysisProfile(
      executableTarget("elf", "x86_64"),
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok || resolved.value.profile === null) return;
    expect(resolved.value.profile).toMatchObject({
      provider: { id: "ghidra", name: "Ghidra", version: "12.1.2" },
      provider_profile_schema_version: 1,
      parameters: {
        import_mode: "ephemeral-read-only",
        analyzer_preset: "ghidra-default",
        analysis_timeout_seconds: 300,
        max_cpu: 2,
        max_heap: "2G",
      },
    });
    expect(resolved.value.compatibility).toEqual({
      languageId: "auto",
      compilerSpecId: "auto",
    });

    const result = await ghidra
      .createClient(executableTarget("elf", "x86_64"), resolved.value.profile)
      .execute("list_procedures", {});
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCapabilityUnavailableError",
        providerId: "ghidra",
      },
    });
  });

  it("returns cancellation before profile work", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider().resolveAnalysisProfile(executableTarget("elf", "x86_64"), {
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError", operation: "open_binary" },
    });
  });
});

const executableTarget = (
  format: BinaryTarget["format"],
  architecture?: NonNullable<BinaryTarget["architecture"]>,
): BinaryTarget => ({
  path: "/tmp/fixture",
  sha256: "a".repeat(64),
  kind: "executable",
  format,
  ...(architecture === undefined
    ? {}
    : { architecture, availableArchitectures: [architecture] }),
});
