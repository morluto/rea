import { describe, expect, it } from "vitest";

import { parseConfig } from "../config.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import {
  GHIDRA_PROVIDER_IDENTITY,
  GHIDRA_PROVIDER_TOOL_CONTRACTS,
  GhidraProvider,
  type GhidraProviderClientFactory,
} from "./GhidraProvider.js";
import type { GhidraInstallationHost } from "./GhidraInstallation.js";
import { GHIDRA_SESSION_CAPABILITIES } from "./GhidraSessionValues.js";
import { err, ok } from "../domain/result.js";
import { GhidraSessionError } from "./GhidraSessionError.js";
import { silentLogger } from "../logger.js";

const INSTALL = "/opt/ghidra_12.1.2_PUBLIC";
const installationHost = (): GhidraInstallationHost => ({
  platform: "linux",
  architecture: "x64",
  readText: () => "application.version=12.1.2\n",
  executable: () => true,
  probeJava: () => ({
    version: "21.0.11",
    major: 21,
    home: "/usr/lib/jvm/jdk-21",
    bits: 64,
    runtime: "jdk",
  }),
});

const provider = (
  host = installationHost(),
  clientFactory?: GhidraProviderClientFactory,
): GhidraProvider => {
  const config = parseConfig({ GHIDRA_INSTALL_DIR: INSTALL });
  if (!config.ok) throw config.error;
  return new GhidraProvider(config.value, silentLogger, host, clientFactory);
};

describe("Ghidra provider", () => {
  it("discovers the exact installation once without launching Ghidra", () => {
    let probeCount = 0;
    const host: GhidraInstallationHost = {
      ...installationHost(),
      probeJava: () => {
        probeCount += 1;
        return {
          version: "21.0.11",
          major: 21,
          home: "/usr/lib/jvm/jdk-21",
          bits: 64,
          runtime: "jdk",
        };
      },
    };
    const ghidra = provider(host);

    expect(ghidra.identity()).toEqual(GHIDRA_PROVIDER_IDENTITY);
    expect(ghidra.capabilities().map(({ operation }) => operation)).toEqual(
      GHIDRA_PROVIDER_TOOL_CONTRACTS.map(({ name }) => name),
    );
    expect(GHIDRA_PROVIDER_TOOL_CONTRACTS).toHaveLength(19);
    expect(ghidra.capabilities()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "list_procedures",
          pagination: "offset",
          effects: expect.objectContaining({
            mutatesArtifact: false,
            mayShowUi: false,
            mayWriteFilesystem: true,
          }),
          limits: {
            maxResults: 500,
            maxPayloadBytes: 1024 * 1024,
            timeoutMs: 10_000,
          },
        }),
        expect.objectContaining({
          operation: "analyze_function",
          pagination: "offset",
          limits: {
            maxResults: 500,
            maxPayloadBytes: 1024 * 1024,
            timeoutMs: 35_000,
          },
          limitations: expect.arrayContaining([
            expect.stringContaining(
              "unresolved targetless flows remain unknown",
            ),
          ]),
        }),
      ]),
    );
    expect(ghidra.inspectAvailability()).toMatchObject({
      status: "available",
      diagnostics: {
        install_dir: INSTALL,
        provider_version: "12.1.2",
        java_version: "21.0.11",
      },
    });
    expect(ghidra.inspectAvailability()).toMatchObject({ status: "available" });
    expect(probeCount).toBe(1);
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
        path: "/tmp/fixture.asar",
        sha256: "a".repeat(64),
        kind: "archive",
        format: "asar",
      }),
    ).toMatchObject({
      status: "unsupported",
      code: "target_kind_unsupported",
    });
    expect(
      ghidra.inspectTargetSupport({
        path: "/tmp/fixture.js",
        sha256: "a".repeat(64),
        kind: "artifact",
        format: "javascript",
      }),
    ).toMatchObject({
      status: "unsupported",
      code: "target_kind_unsupported",
    });
  });
});

describe("Ghidra platform support", () => {
  it("keeps Windows P0 unavailable until native isolation authority exists", () => {
    const ghidra = provider({ ...installationHost(), platform: "win32" });
    const nativeApplication = peTarget("x86_64");

    expect(ghidra.inspectTargetSupport(nativeApplication)).toMatchObject({
      status: "supported",
      diagnostics: {
        host_platform: "win32",
        executable_role: "application",
        managed: false,
      },
    });
    expect(ghidra.inspectAvailability()).toMatchObject({
      status: "unavailable",
      code: "unsupported_host",
      reason: expect.stringContaining("native authority is unavailable"),
      diagnostics: {
        windows_security: {
          job_object_process_ownership: expect.objectContaining({
            available: false,
            proof: "not-proven",
          }),
          private_runtime_dacl: expect.objectContaining({
            available: false,
            proof: "not-proven",
          }),
          reparse_safe_path_admission: expect.objectContaining({
            available: false,
            proof: "not-proven",
          }),
        },
      },
    });
    expect(ghidra.capabilities()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "list_procedures",
          available: false,
          availabilityCode: "unsupported_host",
          limitations: expect.arrayContaining([
            expect.stringContaining("bounded taskkill cleanup"),
            expect.stringContaining("private DACL enforcement"),
          ]),
        }),
      ]),
    );
    expect(
      ghidra.inspectTargetSupport({
        ...nativeApplication,
        executableRole: "shared-library",
      }),
    ).toMatchObject({
      status: "unsupported",
      code: "target_role_unsupported",
    });
    expect(
      ghidra.inspectTargetSupport({ ...nativeApplication, managed: true }),
    ).toMatchObject({
      status: "unsupported",
      code: "managed_target_unsupported",
    });
    expect(
      ghidra.inspectTargetSupport(executableTarget("elf", "x86_64")),
    ).toMatchObject({
      status: "unsupported",
      code: "target_format_unsupported",
    });
    expect(
      ghidra.inspectTargetSupport(executableTarget("pe", "arm64")),
    ).toMatchObject({
      status: "unsupported",
      code: "architecture_unsupported",
    });
  });
});

describe("Ghidra client projection", () => {
  it("commits exact provider, isolation, and resource semantics", async () => {
    const toolCalls: Array<{
      readonly operation: string;
      readonly input: unknown;
      readonly options: unknown;
    }> = [];
    let startCount = 0;
    const factoryOptions: unknown[] = [];
    const callTool: ReturnType<GhidraProviderClientFactory>["callTool"] = (
      operation,
      input,
      options,
    ) => {
      toolCalls.push({ operation, input, options });
      return Promise.resolve(
        ok({
          items: [
            {
              address: "0x1000",
              value: "fixture_main",
              value_truncated: false,
              procedure: {
                external: false,
                thunk: false,
                thunk_target: null,
              },
            },
          ],
          offset: 0,
          limit: 100,
          total: 1,
          next_offset: null,
          has_more: false,
        }),
      );
    };
    const clientFactory: GhidraProviderClientFactory = (options) => {
      factoryOptions.push(options);
      return {
        start: () => {
          startCount += 1;
          return Promise.resolve(ok(sessionInfo()));
        },
        callTool,
        close: () => Promise.resolve(),
      };
    };
    const ghidra = provider(installationHost(), clientFactory);
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
      .createClient(executableTarget("elf", "x86_64"), resolved.value.profile, {
        runId: "11111111-1111-4111-8111-111111111111",
      })
      .execute("list_procedures", {});
    expect(factoryOptions).toEqual([
      expect.objectContaining({
        runId: "11111111-1111-4111-8111-111111111111",
      }),
    ]);
    expect(toolCalls).toEqual([
      {
        operation: "list_procedures",
        input: { document: null, offset: 0, limit: 100 },
        options: {},
      },
    ]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        provider: {
          id: "ghidra",
          name: "Ghidra",
          version: "12.1.2",
        },
        analysisProfile: resolved.value.profile,
        result: {
          items: [{ address: "0x1000", value: "fixture_main" }],
          total: 1,
        },
        rawResult: {
          items: [{ procedure: { external: false, thunk: false } }],
        },
      },
    });
    expect(startCount).toBe(0);
  });
});

describe("Ghidra result projection", () => {
  it("rejects malformed inventory output before Evidence creation", async () => {
    const ghidra = provider(installationHost(), () => ({
      start: () => Promise.resolve(ok(sessionInfo())),
      callTool: () => Promise.resolve(ok({ items: "not-a-page" })),
      close: () => Promise.resolve(),
    }));
    const resolved = await ghidra.resolveAnalysisProfile(
      executableTarget("elf", "x86_64"),
    );
    if (!resolved.ok || resolved.value.profile === null) return;

    await expect(
      ghidra
        .createClient(executableTarget("elf", "x86_64"), resolved.value.profile)
        .execute("list_procedures", {}),
    ).resolves.toMatchObject({
      ok: false,
      error: { _tag: "AnalysisOutputError" },
    });
  });

  it.each([
    ["invalid_request", "AnalysisInputError"],
    ["not_found", "AnalysisInputError"],
    ["ambiguous", "AnalysisInputError"],
    ["method_unavailable", "AnalysisCapabilityUnavailableError"],
  ] as const)(
    "projects remote %s without losing its typed meaning",
    async (code, tag) => {
      const ghidra = provider(installationHost(), () => ({
        start: () => Promise.resolve(ok(sessionInfo())),
        callTool: () =>
          Promise.resolve(
            err(
              new GhidraSessionError(
                "remote",
                "Fixture remote failure",
                { remote_code: code },
                { remoteCode: code },
              ),
            ),
          ),
        close: () => Promise.resolve(),
      }));
      const resolved = await ghidra.resolveAnalysisProfile(
        executableTarget("elf", "x86_64"),
      );
      if (!resolved.ok || resolved.value.profile === null) return;

      await expect(
        ghidra
          .createClient(
            executableTarget("elf", "x86_64"),
            resolved.value.profile,
          )
          .execute("list_procedures", {}),
      ).resolves.toMatchObject({ ok: false, error: { _tag: tag } });
    },
  );

  it.each([
    ["decompile_timeout", "AnalysisTimeoutError", 30_000],
    ["decompile_cancelled", "AnalysisCancelledError", undefined],
  ] as const)(
    "projects remote %s as a provider-neutral interruption",
    async (code, tag, timeoutMs) => {
      const ghidra = provider(installationHost(), () => ({
        start: () => Promise.resolve(ok(sessionInfo())),
        callTool: () =>
          Promise.resolve(
            err(
              new GhidraSessionError(
                "remote",
                "Fixture decompiler interruption",
                { remote_code: code },
                { remoteCode: code },
              ),
            ),
          ),
        close: () => Promise.resolve(),
      }));
      const resolved = await ghidra.resolveAnalysisProfile(
        executableTarget("elf", "x86_64"),
      );
      if (!resolved.ok || resolved.value.profile === null) return;

      const result = await ghidra
        .createClient(executableTarget("elf", "x86_64"), resolved.value.profile)
        .execute("procedure_pseudo_code", { procedure: "main" });
      expect(result).toMatchObject({
        ok: false,
        error: {
          _tag: tag,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
      });
    },
  );

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

const sessionInfo = () => ({
  name: "REA Ghidra bridge" as const,
  bridge_version: 6 as const,
  run_id: "11111111-1111-4111-8111-111111111111",
  profile_digest: "a".repeat(64),
  provider: { id: "ghidra" as const, version: "12.1.2" },
  read_only: true as const,
  analysis_complete: true,
  analysis_timed_out: false,
  capabilities: [...GHIDRA_SESSION_CAPABILITIES],
  target: {
    name: "fixture",
    language_id: "x86:LE:64:default",
    compiler_spec_id: "gcc",
    image_base: "0x1000",
    default_address_space: "ram",
    sha256: "a".repeat(64),
  },
});

const executableTarget = (
  format: "mach-o" | "elf" | "pe",
  architecture: NonNullable<BinaryTarget["architecture"]>,
): BinaryTarget =>
  format === "pe"
    ? peTarget(architecture)
    : {
        path: "/tmp/fixture",
        sha256: "a".repeat(64),
        kind: "executable",
        format,
        architecture,
        availableArchitectures: [architecture],
      };

const peTarget = (
  architecture: NonNullable<BinaryTarget["architecture"]>,
): Extract<BinaryTarget, { format: "pe" }> => ({
  path: "/tmp/fixture",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "pe",
  architecture,
  availableArchitectures: [architecture],
  executableRole: "application",
  managed: false,
});
