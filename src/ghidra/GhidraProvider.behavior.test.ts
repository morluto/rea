import type { GhidraSeedReport } from "./GhidraAnalysisSeeds.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
// Fake-backed provider coverage; real Ghidra verification lives in
// `npm run verify:ghidra` and its focused variants.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { fixtureDosLoadImage } from "./GhidraLoadImage.fixture.js";
import { fixtureRawBinaryLoadImage } from "./GhidraRawBinaryLoadImage.fixture.js";
import {
  nativeAotPeDigest,
  nativeAotPeFixture,
} from "../../tests/fixtures/nativeaotPe.js";
import { jsonValueSchema } from "../domain/jsonValue.js";

import { parseConfig } from "../config/parseConfig.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { parseExecutableHeader } from "../domain/binaryTarget.js";
import { GhidraProvider } from "./GhidraProvider.js";
import type { GhidraTargetSnapshot } from "./GhidraClient.js";
import type { GhidraProviderClientFactory } from "./GhidraProviderClient.js";
import type { GhidraHeadlessLauncher } from "./GhidraLauncher.js";
import type { GhidraInstallationHost } from "./GhidraInstallation.js";
import { GHIDRA_SESSION_CAPABILITIES } from "./GhidraSessionValues.js";
import { err, ok } from "../domain/result.js";
import type { Result } from "../domain/result.js";
import { GhidraSessionError } from "./GhidraSessionError.js";
import { silentLogger } from "../logger.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ProviderStartupDeadline } from "../process/ProviderDeadline.js";

const INSTALL = "/opt/ghidra_12.1.4_PUBLIC";
const installationHost = (): GhidraInstallationHost => ({
  platform: "linux",
  architecture: "x64",
  readText: () => "application.version=12.1.4\napplication.java.min=21\n",
  executable: () => true,
  probeJava: () => ({
    version: "21.0.11",
    major: 21,
    home: "/usr/lib/jvm/jdk-21",
    bits: 64,
    runtime: "jdk",
    vmName: "OpenJDK 64-Bit Server VM",
  }),
});

const provider = (
  host = installationHost(),
  clientFactory?: GhidraProviderClientFactory,
): GhidraProvider => {
  const config = parseConfig({ GHIDRA_INSTALL_DIR: INSTALL });
  if (!config.ok) throw config.error;
  return new GhidraProvider(
    config.value,
    silentLogger,
    {},
    host,
    clientFactory,
  );
};

const createElfClient = async (ghidra: GhidraProvider) => {
  const target = executableTarget("elf", "x86_64");
  const resolved = await ghidra.resolveAnalysisProfile(target);
  if (!resolved.ok) throw resolved.error;
  if (resolved.value.profile === null)
    throw new Error("Expected a bound Ghidra profile");
  return ghidra.createClient(target, resolved.value.profile);
};

describe("Ghidra provider", () => {
  it("commits DOS loader and real-mode language while retaining the CPU family", async () => {
    const ghidra = provider();
    const target: BinaryTarget = {
      path: "/tmp/legacy.exe",
      sha256: "a".repeat(64),
      kind: "executable",
      format: "dos-mz",
      architecture: "x86",
      availableArchitectures: ["x86"],
    };
    expect(ghidra.inspectTargetSupport(target).status).toBe("supported");
    const resolved = await ghidra.resolveAnalysisProfile(target);
    expect(resolved.ok && resolved.value).toMatchObject({
      profile: {
        parameters: {
          target_format: "dos-mz",
          architecture: "x86",
          loader: "MzLoader",
          language_id: "x86:LE:16:Real Mode",
          compiler_spec_id: "default",
          load_segment: "0x1000",
          address_coordinates: "linear-byte-offset",
        },
      },
    });
    const windows = provider({ ...installationHost(), platform: "win32" });
    expect(windows.inspectTargetSupport(target).status).toBe("unsupported");
  });
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

    expect(ghidra.capabilities()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "list_procedures",
          effects: expect.objectContaining({
            mutatesArtifact: false,
            mayShowUi: false,
            mayWriteFilesystem: true,
          }),
        }),
        expect.objectContaining({
          operation: "analyze_function",
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
        provider_version: "12.1.4",
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

describe("Ghidra raw-binary profile", () => {
  it("commits BinaryLoader language and caller-supplied entry", async () => {
    const ghidra = provider();
    const target: BinaryTarget = {
      path: "/tmp/ecu.bin",
      sha256: "a".repeat(64),
      kind: "executable",
      format: "raw-binary",
      architecture: "arm",
      availableArchitectures: ["arm"],
      entryPoint: "0x8000000",
      entryPointSource: "0x08000000",
    };
    expect(ghidra.inspectTargetSupport(target).status).toBe("supported");
    const resolved = await ghidra.resolveAnalysisProfile(target);
    expect(resolved.ok && resolved.value).toMatchObject({
      profile: {
        parameters: {
          target_format: "raw-binary",
          architecture: "arm",
          loader: "BinaryLoader",
          language_id: "ARM:LE:32:v7",
          compiler_spec_id: "default",
          language_selection: "caller-supplied-v1",
          entry_point: "0x8000000",
        },
      },
    });
    const shifted = await ghidra.resolveAnalysisProfile({
      ...target,
      entryPoint: "0x8001000",
      entryPointSource: "0x8001000",
    });
    expect(resolved.ok && shifted.ok).toBe(true);
    if (!resolved.ok || !shifted.ok || resolved.value.profile === null)
      throw new Error("expected raw-binary profiles");
    expect(shifted.value.profile?.digest).not.toBe(
      resolved.value.profile.digest,
    );
    const windows = provider({ ...installationHost(), platform: "win32" });
    expect(windows.inspectTargetSupport(target).status).toBe("unsupported");
  });
});

describe("Ghidra Mach-O slice support", () => {
  it("refuses universal targets whose selected slice cannot be enforced", () => {
    const ghidra = provider();
    const universal: BinaryTarget = {
      path: "/tmp/fixture",
      sha256: "a".repeat(64),
      kind: "executable",
      format: "mach-o-universal",
      architecture: "arm64",
      availableArchitectures: ["x86_64", "arm64"],
      universalSlice: { offset: 0, size: 32 },
    };

    expect(ghidra.inspectTargetSupport(universal)).toMatchObject({
      status: "unsupported",
      code: "architecture_unsupported",
      reason: expect.stringContaining("universal Mach-O"),
      diagnostics: {
        architecture: "arm64",
        available_architectures: ["x86_64", "arm64"],
      },
    });
    expect(
      ghidra.inspectTargetSupport(executableTarget("mach-o", "arm64")),
    ).toMatchObject({ status: "supported" });

    expect(
      ghidra.inspectTargetSupport({
        ...universal,
        availableArchitectures: ["arm64"] as const,
      }),
    ).toMatchObject({ status: "supported" });
  });
});

describe("Ghidra platform support", () => {
  it("commits the PE role and managed classification to profile identity", async () => {
    const ghidra = provider({ ...installationHost(), platform: "win32" });
    const application = peTarget("x86_64");
    const library = {
      ...application,
      executableRole: "shared-library",
    } as const;
    const digests = new Set<string>();
    for (const target of [
      application,
      library,
      { ...library, managed: true },
    ]) {
      const resolved = await ghidra.resolveAnalysisProfile(target);
      if (!resolved.ok) throw resolved.error;
      const profile = resolved.value.profile;
      if (profile === null) throw new Error("Expected a PE analysis profile");
      expect(profile.parameters).toMatchObject({
        executable_role: target.executableRole,
        managed: target.managed,
        native_aot_metadata: {
          contract_revision: "rtr-9.1-x64-pe-read-only-v3",
          source_bytes: 128 * 1024 * 1024,
          work_units: 64 * 1024 * 1024,
          working_memory_bytes: 64 * 1024 * 1024,
          report_bytes: 4 * 1024 * 1024,
        },
      });
      digests.add(profile.digest);
    }
    expect(digests.size).toBe(3);
    const nonPe = await ghidra.resolveAnalysisProfile(
      executableTarget("elf", "x86_64"),
    );
    if (!nonPe.ok || nonPe.value.profile === null)
      throw new Error("Expected a non-PE analysis profile");
    expect(nonPe.value.profile.parameters).not.toHaveProperty(
      "native_aot_metadata",
    );
  });

  it("keeps Windows annotation mutation unavailable independently of native controls", () => {
    const ghidra = provider({ ...installationHost(), platform: "win32" });
    expect(
      ghidra
        .capabilities()
        .find(({ operation }) => operation === "annotate_native_function"),
    ).toMatchObject({
      available: false,
      reason: "Windows Ghidra P0 does not admit database mutation.",
      availabilityCode: "unsupported_host",
    });
  });

  it("keeps Windows P0 unavailable until native isolation authority exists", () => {
    const ghidra = provider({ ...installationHost(), platform: "win32" });
    const nativeApplication = peTarget("x86_64");

    for (const architecture of ["x86", "x86_64"] as const)
      expect(ghidra.inspectTargetSupport(peTarget(architecture))).toMatchObject(
        {
          status: "supported",
          diagnostics: {
            host_platform: "win32",
            architecture,
            executable_role: "application",
            managed: false,
          },
        },
      );
    expect(ghidra.inspectAvailability()).toMatchObject({
      status: "unavailable",
      code: "unsupported_host",
      reason: expect.stringContaining(
        "Windows native controls are unavailable",
      ),
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
            expect.stringContaining(
              "matching packaged Windows x64 native addon",
            ),
            expect.stringContaining(
              "private DACLs, and Job Object ownership automatically",
            ),
          ]),
        }),
      ]),
    );
    expect(
      ghidra.inspectTargetSupport({
        ...nativeApplication,
        executableRole: "non-executable",
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

describe("Ghidra Windows PE fixture admission", () => {
  it("admits generated PE32 and PE32+ DLLs and applications while preserving native-only Windows admission", async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    await promisify(execFile)(process.execPath, [
      join(root, "scripts/create-ghidra-windows-fixture.mjs"),
    ]);
    const ghidra = provider({ ...installationHost(), platform: "win32" });
    for (const architecture of ["x86", "x86_64"] as const) {
      for (const dll of [false, true]) {
        const path = join(
          root,
          "build/fixtures",
          `rea-ghidra-windows${architecture === "x86" ? "-x86" : ""}.${dll ? "dll" : "exe"}`,
        );
        const bytes = await readFile(path);
        const metadata = parseExecutableHeader(bytes, "x64");
        const role = dll ? "shared-library" : "application";
        expect(metadata).toMatchObject({
          ok: true,
          value: {
            format: "pe",
            architecture,
            executableRole: role,
            managed: false,
          },
        });
        if (!metadata.ok) throw new Error(metadata.error);
        if (metadata.value.format !== "pe")
          throw new Error("Expected a PE fixture");
        const target: BinaryTarget = {
          path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          kind: "executable",
          ...metadata.value,
        };
        expect(ghidra.inspectTargetSupport(target).status).toBe("supported");
        for (const [candidate, code] of [
          [
            { ...target, executableRole: "non-executable" },
            "target_role_unsupported",
          ],
          [{ ...target, managed: true }, "managed_target_unsupported"],
          [{ ...target, architecture: "arm64" }, "architecture_unsupported"],
        ] as const) {
          expect(ghidra.inspectTargetSupport(candidate)).toMatchObject({
            status: "unsupported",
            code,
          });
        }
      }
    }
  });
});

describe("Ghidra startup configuration", () => {
  it("carries supplied startup settings through configuration, the provider, the timer and timeout diagnostics", async () => {
    const target = executableTarget("elf", "x86_64");
    for (const [raw, expected] of [
      [undefined, 330_000],
      ["900000", 900_000],
      ["1260000", 1_260_000],
      ["2147483647", 2_147_483_647],
    ] as const) {
      const config = parseConfig({
        GHIDRA_INSTALL_DIR: INSTALL,
        ...(raw === undefined ? {} : { REA_GHIDRA_STARTUP_TIMEOUT_MS: raw }),
      });
      if (!config.ok) throw config.error;
      let timeout: number | undefined;
      const ghidra = new GhidraProvider(
        config.value,
        silentLogger,
        {},
        installationHost(),
        (options) => {
          timeout = options.startupTimeoutMs;
          return {
            start: () =>
              Promise.resolve(
                err(
                  new GhidraSessionError(
                    "timeout",
                    "Startup deadline elapsed",
                    {},
                  ),
                ),
              ),
            callTool: () => Promise.resolve(ok([])),
            close: () => Promise.resolve(ok(null)),
          };
        },
      );
      const profile = await ghidra.resolveAnalysisProfile(target);
      if (!profile.ok) throw profile.error;
      if (profile.value.profile === null)
        throw new Error("Expected a bound profile");
      const client = ghidra.createClient(target, profile.value.profile);
      try {
        const failure = await client.execute("health", {});
        expect(timeout, String(raw)).toBe(expected);
        expect(failure).toMatchObject({
          ok: false,
          error: { _tag: "AnalysisTimeoutError", timeoutMs: expected },
        });
        if (timeout === undefined)
          throw new Error("Provider omitted startup deadline");
        const deadline = new ProviderStartupDeadline(timeout);
        try {
          expect(await deadline.wait(20)).toBe("elapsed");
          expect(deadline.signal.aborted).toBe(false);
        } finally {
          deadline.dispose();
        }
      } finally {
        await client.close();
      }
    }
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
        ok([
          {
            address: "0x1000",
            value: "fixture_main",
            procedure: {
              external: false,
              thunk: false,
              thunk_target: null,
            },
          },
        ]),
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
        close: () => Promise.resolve(ok(null)),
      };
    };
    const ghidra = provider(installationHost(), clientFactory);
    const resolved = await ghidra.resolveAnalysisProfile(
      executableTarget("elf", "x86_64"),
    );

    if (!resolved.ok) throw resolved.error;
    if (resolved.value.profile === null)
      throw new Error("Expected a bound Ghidra profile");
    expect(resolved.value.profile).toMatchObject({
      provider: { id: "ghidra", name: "Ghidra", version: "12.1.4" },
      parameters: {
        import_mode: "ephemeral-source-immutable",
        annotation_policy: "atomic-function-entry-metadata-v1",
        analyzer_preset: "ghidra-default",
      },
    });
    expect(resolved.value.profile.parameters).toMatchObject({
      language_id: "auto-from-header",
      compiler_spec_id: "auto-default",
      call_relationship_coverage: "resolved-call-reference-diagnostics-v1",
    });

    const result = await ghidra
      .createClient(executableTarget("elf", "x86_64"), resolved.value.profile, {
        runId: "11111111-1111-4111-8111-111111111111",
      })
      .execute("list_procedures", {});
    expect(factoryOptions).toEqual([
      expect.objectContaining({
        runId: "11111111-1111-4111-8111-111111111111",
        platform: "linux",
        launcher: expect.objectContaining({
          options: expect.objectContaining({
            javaVmName: "OpenJDK 64-Bit Server VM",
          }),
        }),
      }),
    ]);
    expect(toolCalls).toEqual([
      {
        operation: "list_procedures",
        input: { document: null },
        options: {},
      },
    ]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        provider: {
          id: "ghidra",
          name: "Ghidra",
          version: "12.1.4",
        },
        analysisProfile: resolved.value.profile,
        result: [{ address: "0x1000", value: "fixture_main" }],
        rawResult: [{ procedure: { external: false, thunk: false } }],
      },
    });
    expect(startCount).toBe(0);
  });
});

describe("Ghidra result projection", () => {
  it("rejects malformed inventory output before Evidence creation", async () => {
    const ghidra = provider(installationHost(), () => ({
      start: () => Promise.resolve(ok(sessionInfo())),
      callTool: () => Promise.resolve(ok({ items: "not-an-inventory" })),
      close: () => Promise.resolve(ok(null)),
    }));
    const client = await createElfClient(ghidra);
    await expect(client.execute("list_procedures", {})).resolves.toMatchObject({
      ok: false,
      error: { _tag: "AnalysisOutputError" },
    });
  });

  it("projects terminal-call facts from the function bridge into execution limitations", async () => {
    const limitation =
      "Ghidra Listing reports a terminal call at 0x401020 to 0x7f001000 __tls_get_addr (external=true, thunk=false, hasNoReturn=true); fallthrough is excluded by Ghidra's flow model. This records Ghidra's FunctionManager flag, not an independent verification that the callee cannot return.";
    const ghidra = provider(installationHost(), () => ({
      start: () => Promise.resolve(ok(sessionInfo())),
      callTool: () =>
        Promise.resolve(
          ok({ value: "void main() {}", limitations: [limitation] }),
        ),
      close: () => Promise.resolve(ok(null)),
    }));
    const client = await createElfClient(ghidra);
    const execution = await client.execute("procedure_pseudo_code", {
      procedure: "main",
    });
    if (!execution.ok) throw execution.error;
    expect(execution.value.result).toBe("void main() {}");
    expect(execution.value.limitations).toContain(limitation);
    expect(execution.value.rawResult).toEqual({
      value: "void main() {}",
      limitations: [limitation],
    });
    await client.close();
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
        close: () => Promise.resolve(ok(null)),
      }));
      const client = await createElfClient(ghidra);
      await expect(
        client.execute("list_procedures", {}),
      ).resolves.toMatchObject({
        ok: false,
        error: { _tag: tag },
      });
    },
  );

  it("preserves the rejected name constraint and function address", async () => {
    const message =
      "Invalid function name at 0x10100: Symbol name contains invalid characters";
    const ghidra = provider(installationHost(), () => ({
      start: () => Promise.resolve(ok(sessionInfo())),
      callTool: () =>
        Promise.resolve(
          err(
            new GhidraSessionError(
              "remote",
              message,
              {},
              { remoteCode: "invalid_function_name" },
            ),
          ),
        ),
      close: () => Promise.resolve(ok(null)),
    }));
    const client = await createElfClient(ghidra);
    await expect(
      client.execute("annotate_native_function", {
        procedure: "0x10100",
        name: "bad name",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        issues: [{ path: ["name"], reason: "invalid_value", message }],
      },
    });
  });

  it("projects remote decompile cancellation as a provider-neutral interruption", async () => {
    const code = "decompile_cancelled";
    const tag = "AnalysisCancelledError";
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
      close: () => Promise.resolve(ok(null)),
    }));
    const client = await createElfClient(ghidra);
    const result = await client.execute("procedure_pseudo_code", {
      procedure: "main",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: tag },
    });
    if (!result.ok)
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "cancelled",
        details: { diagnostics: { remote_code: code } },
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

describe("Ghidra relationship coverage", () => {
  it("marks the full direct call-reference response complete while keeping static caveats", async () => {
    const ghidra = provider(installationHost(), () => ({
      start: () => Promise.resolve(ok(sessionInfo())),
      callTool: (operation) =>
        Promise.resolve(
          ok(operation === "procedure_callees" ? ["0x2000"] : []),
        ),
      close: () => Promise.resolve(ok(null)),
    }));
    const client = await createElfClient(ghidra);
    const execution = await client.execute("procedure_callees", {
      procedure: "0x1000",
      document: "fixture",
    });
    if (!execution.ok) throw execution.error;
    expect(execution.value.relationshipCoverage).toEqual({
      status: "complete",
      diagnostics: [
        "Only resolved Ghidra call references are returned; unresolved computed or indirect calls remain unknown, while function classifications distinguish thunks and externals.",
      ],
    });
    expect(execution.value.limitations).not.toContain(
      "Only resolved Ghidra call references are returned; unresolved computed or indirect calls remain unknown, while function classifications distinguish thunks and externals.",
    );
    await client.close();
  });
});

describe("Ghidra measured load-image projection", () => {
  it.each(["verified", "changed-snapshot", "cancelled"] as const)(
    "streams raw snapshot identity and preserves %s outcomes",
    async (state) => {
      const fixture = fixtureRawBinaryLoadImage();
      const controller = new AbortController();
      const signals: (AbortSignal | undefined)[] = [];
      const ghidra = provider(installationHost(), () => ({
        start: () => Promise.resolve(ok(sessionInfo())),
        callTool: (operation) => {
          if (operation !== "inspect_native_load_image")
            throw new Error(`unexpected operation ${operation}`);
          return Promise.resolve(
            ok(jsonValueSchema.parse(fixture.observation)),
          );
        },
        readTargetSnapshot: () => {
          throw new Error(
            "raw verification must not capture the complete file",
          );
        },
        hashTargetSnapshot: (signal) => {
          signals.push(signal);
          if (state === "cancelled") {
            controller.abort();
            return Promise.resolve(
              err(
                new GhidraSessionError(
                  "cancelled",
                  "Snapshot hashing cancelled",
                ),
              ),
            );
          }
          return Promise.resolve(
            ok({
              ...fixture.snapshot,
              ...(state === "changed-snapshot"
                ? { sha256: "f".repeat(64) }
                : {}),
            }),
          );
        },
        close: () => Promise.resolve(ok(null)),
      }));
      const resolved = await ghidra.resolveAnalysisProfile(fixture.target);
      if (!resolved.ok) throw resolved.error;
      if (resolved.value.profile === null)
        throw new Error("expected raw profile");
      const client = ghidra.createClient(
        fixture.target,
        resolved.value.profile,
      );
      try {
        const result = await client.execute(
          "inspect_native_load_image",
          {},
          { signal: controller.signal },
        );
        expect(signals).toEqual([controller.signal]);
        if (state === "verified") {
          if (!result.ok) throw result.error;
          expect(result.value.result).toMatchObject({
            status: "verified",
            observations: fixture.observation,
          });
        } else {
          expect(result).toMatchObject({
            ok: false,
            error: {
              _tag:
                state === "cancelled"
                  ? "AnalysisCancelledError"
                  : "ProviderAdapterError",
            },
          });
        }
      } finally {
        await client.close();
      }
    },
  );

  it.each([
    "verified",
    "mismatch",
    "changed-snapshot",
    "unsupported",
    "missing-snapshot",
  ] as const)(
    "preserves %s state and producing observations",
    async (state) => {
      const fixture = fixtureDosLoadImage();
      if (state === "mismatch") fixture.observation.entry_points = ["0x10001"];
      if (state === "changed-snapshot") fixture.bytes[0] = 0;
      const factory: GhidraProviderClientFactory = () => ({
        start: () => Promise.resolve(ok(sessionInfo())),
        callTool: () =>
          Promise.resolve(ok(jsonValueSchema.parse(fixture.observation))),
        close: () => Promise.resolve(ok(null)),
        ...(state === "missing-snapshot"
          ? {}
          : {
              readTargetSnapshot: () =>
                Promise.resolve(ok({ kind: "captured", bytes: fixture.bytes })),
            }),
      });
      const ghidra = provider(installationHost(), factory);
      const target: BinaryTarget = {
        path: "/tmp/source-owned-fixture.exe",
        sha256: fixture.sha256,
        kind: "executable",
        format: state === "unsupported" ? "elf" : "dos-mz",
        architecture: "x86",
        availableArchitectures: ["x86"],
      };
      const profile = await ghidra.resolveAnalysisProfile(target);
      if (!profile.ok || profile.value.profile === null)
        throw new Error("Expected admitted profile");
      const result = await ghidra
        .createClient(target, profile.value.profile)
        .execute("inspect_native_load_image", {});
      if (state === "changed-snapshot" || state === "missing-snapshot") {
        expect(result).toMatchObject({
          ok: false,
          error: {
            _tag: "ProviderAdapterError",
            diagnostics: { reason: expect.stringContaining("snapshot") },
          },
        });
      } else {
        expect(result).toMatchObject({
          ok: true,
          value: {
            result: { status: state, observations: fixture.observation },
            rawResult: fixture.observation,
            analysisProfile: profile.value.profile,
          },
        });
      }
    },
  );
});

it("returns read-only NativeAOT metadata inline and drills down by derived MethodTable address", async () => {
  const bytes = nativeAotPeFixture();
  const observations = fixtureDosLoadImage().observation;
  observations.image_base = "0x140000000";
  const factory: GhidraProviderClientFactory = () => ({
    start: () =>
      Promise.resolve(
        ok({
          ...sessionInfo(),
          target: { ...sessionInfo().target, image_base: "0x140000000" },
        }),
      ),
    callTool: (operation) =>
      Promise.resolve(
        ok(
          jsonValueSchema.parse(
            operation === "inspect_native_load_image"
              ? observations
              : {
                  status: "unavailable",
                  reason: "No Ghidra DataType is defined at this address.",
                  id: null,
                  name: null,
                  kind: "unavailable",
                  source: "analysis-database",
                  source_archive: null,
                  address: null,
                  size_bytes: null,
                  alignment_bytes: null,
                  packing_enabled: null,
                  referenced_type: null,
                  array_count: null,
                  array_stride_bytes: null,
                  fields: [],
                  members: [],
                  total_fields: 0,
                  truncated: false,
                  limitations: [],
                },
          ),
        ),
      ),
    readTargetSnapshot: () => Promise.resolve(ok({ kind: "captured", bytes })),
    close: () => Promise.resolve(ok(null)),
  });
  const ghidra = provider(installationHost(), factory);
  const target = { ...peTarget("x86_64"), sha256: nativeAotPeDigest(bytes) };
  const profile = await ghidra.resolveAnalysisProfile(target);
  if (!profile.ok || profile.value.profile === null)
    throw new Error("Expected admitted PE profile");
  const client = ghidra.createClient(target, profile.value.profile);
  const image = await client.execute("inspect_native_load_image", {});
  expect(image).toMatchObject({
    ok: true,
    value: {
      result: {
        status: "unsupported",
        observations: {
          metadata_recovery: [
            {
              status: "complete",
              analysis_mode: "read-only-derived-overlay",
              method_tables: 3,
              frozen_strings: [{ value: "REA_NATIVEAOT_FROZEN" }],
            },
          ],
        },
      },
      rawResult: observations,
    },
  });
  const detail = await client.execute("inspect_native_data_type", {
    address: "0x140002280",
  });
  expect(detail).toMatchObject({
    ok: true,
    value: {
      result: {
        status: "unavailable",
        source: "analysis-database",
        metadata_recovery: {
          source: "read-only-derived-overlay",
          method_table_address: "0x140002280",
          related_type: { address: "0x140002200", type: null },
        },
      },
    },
  });
  await client.close();
});

it("derives PE metadata for a direct type-address query without a load-image call", async () => {
  const bytes = nativeAotPeFixture();
  const operations: string[] = [];
  const factory: GhidraProviderClientFactory = () => ({
    start: () =>
      Promise.resolve(
        ok({
          ...sessionInfo(),
          target: { ...sessionInfo().target, image_base: "0x140000000" },
        }),
      ),
    callTool: (operation) => {
      operations.push(operation);
      return Promise.resolve(
        ok(
          jsonValueSchema.parse({
            status: "unavailable",
            reason: "No Ghidra DataType is defined at this address.",
            id: null,
            name: null,
            kind: "unavailable",
            source: "analysis-database",
            source_archive: null,
            address: null,
            size_bytes: null,
            alignment_bytes: null,
            packing_enabled: null,
            referenced_type: null,
            array_count: null,
            array_stride_bytes: null,
            fields: [],
            members: [],
            total_fields: 0,
            truncated: false,
            limitations: [],
          }),
        ),
      );
    },
    readTargetSnapshot: () => Promise.resolve(ok({ kind: "captured", bytes })),
    close: () => Promise.resolve(ok(null)),
  });
  const ghidra = provider(installationHost(), factory);
  const target = { ...peTarget("x86_64"), sha256: nativeAotPeDigest(bytes) };
  const profile = await ghidra.resolveAnalysisProfile(target);
  if (!profile.ok || profile.value.profile === null)
    throw new Error("Expected admitted PE profile");
  const client = ghidra.createClient(target, profile.value.profile);
  const detail = await client.execute("inspect_native_data_type", {
    address: "0x140002280",
  });
  expect(detail).toMatchObject({
    ok: true,
    value: {
      result: {
        metadata_recovery: {
          source: "read-only-derived-overlay",
          method_table_address: "0x140002280",
          related_type: { address: "0x140002200", type: null },
        },
      },
    },
  });
  expect(operations).toEqual(["inspect_native_data_type"]);
  await client.close();
});

it("shares one session snapshot across callers while isolating cancellation and rejecting a changed base", async () => {
  const bytes = nativeAotPeFixture();
  const baseObservation = fixtureDosLoadImage().observation;
  baseObservation.image_base = "0x140000000";
  let calls = 0;
  let snapshotReads = 0;
  let snapshotSignal: AbortSignal | undefined;
  let releaseSnapshot:
    | ((value: Result<GhidraTargetSnapshot, GhidraSessionError>) => void)
    | undefined;
  let markSnapshotStarted: (() => void) | undefined;
  const snapshotStarted = new Promise<void>((resolve) => {
    markSnapshotStarted = resolve;
  });
  const snapshotResult = new Promise<
    Result<GhidraTargetSnapshot, GhidraSessionError>
  >((resolve) => {
    releaseSnapshot = resolve;
  });
  const factory: GhidraProviderClientFactory = () => ({
    start: () => Promise.resolve(ok(sessionInfo())),
    callTool: (operation) => {
      calls += 1;
      const observation = {
        ...baseObservation,
        source_files: [
          { ...baseObservation.source_files[0]!, name: `caller-${calls}` },
        ],
      };
      return Promise.resolve(
        ok(
          jsonValueSchema.parse(
            operation === "inspect_native_load_image"
              ? observation
              : {
                  status: "unavailable",
                  reason: "No Ghidra DataType is defined at this address.",
                  id: null,
                  name: null,
                  kind: "unavailable",
                  source: "analysis-database",
                  source_archive: null,
                  address: null,
                  size_bytes: null,
                  alignment_bytes: null,
                  packing_enabled: null,
                  referenced_type: null,
                  array_count: null,
                  array_stride_bytes: null,
                  fields: [],
                  members: [],
                  total_fields: 0,
                  truncated: false,
                  limitations: [],
                },
          ),
        ),
      );
    },
    readTargetSnapshot: (_maximumBytes, signal) => {
      snapshotReads += 1;
      snapshotSignal = signal;
      markSnapshotStarted?.();
      return snapshotResult;
    },
    close: () => Promise.resolve(ok(null)),
  });
  const ghidra = provider(installationHost(), factory);
  const target = { ...peTarget("x86_64"), sha256: nativeAotPeDigest(bytes) };
  const profile = await ghidra.resolveAnalysisProfile(target);
  if (!profile.ok || profile.value.profile === null)
    throw new Error("Expected admitted PE profile");
  const client = ghidra.createClient(target, profile.value.profile);
  const firstCaller = new AbortController();
  const secondCaller = new AbortController();
  const first = client.execute(
    "inspect_native_load_image",
    {},
    {
      signal: firstCaller.signal,
    },
  );
  const second = client.execute(
    "inspect_native_load_image",
    {},
    {
      signal: secondCaller.signal,
    },
  );
  await snapshotStarted;
  expect(snapshotReads).toBe(1);
  expect(snapshotSignal).toBeDefined();
  expect(snapshotSignal).not.toBe(firstCaller.signal);
  expect(snapshotSignal).not.toBe(secondCaller.signal);
  firstCaller.abort();
  await expect(first).resolves.toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  releaseSnapshot?.(ok({ kind: "captured", bytes }));
  const secondResult = await second;
  expect(secondResult).toMatchObject({
    ok: true,
    value: {
      rawResult: {
        source_files: [{ name: "caller-2" }],
      },
      result: {
        observations: {
          source_files: [{ name: "caller-2" }],
        },
      },
    },
  });
  expect(snapshotReads).toBe(1);
  expect(calls).toBe(2);

  baseObservation.image_base = "0x150000000";
  const conflictingBase = await client.execute("inspect_native_load_image", {});
  expect(conflictingBase).toMatchObject({
    ok: false,
    error: {
      _tag: "ProviderAdapterError",
      diagnostics: {
        reason: expect.stringContaining("different loaded image base"),
      },
    },
  });
  expect(snapshotReads).toBe(1);
  await client.close();
  expect(snapshotSignal?.aborted).toBe(true);
});

it("retries a failed NativeAOT snapshot read without retaining a failed derivation", async () => {
  const bytes = nativeAotPeFixture();
  const observations = fixtureDosLoadImage().observation;
  observations.image_base = "0x140000000";
  let snapshotReads = 0;
  const factory: GhidraProviderClientFactory = () => ({
    start: () => Promise.resolve(ok(sessionInfo())),
    callTool: () => Promise.resolve(ok(jsonValueSchema.parse(observations))),
    readTargetSnapshot: () => {
      snapshotReads += 1;
      return Promise.resolve(
        snapshotReads === 1
          ? err(
              new GhidraSessionError(
                "process",
                "temporary snapshot read failure",
              ),
            )
          : ok({ kind: "captured", bytes }),
      );
    },
    close: () => Promise.resolve(ok(null)),
  });
  const ghidra = provider(installationHost(), factory);
  const target = { ...peTarget("x86_64"), sha256: nativeAotPeDigest(bytes) };
  const profile = await ghidra.resolveAnalysisProfile(target);
  if (!profile.ok || profile.value.profile === null)
    throw new Error("Expected admitted PE profile");
  const client = ghidra.createClient(target, profile.value.profile);
  await expect(
    client.execute("inspect_native_load_image", {}),
  ).resolves.toMatchObject({
    ok: false,
    error: { _tag: "ProviderAdapterError" },
  });
  await expect(
    client.execute("inspect_native_load_image", {}),
  ).resolves.toMatchObject({
    ok: true,
    value: {
      result: {
        observations: {
          metadata_recovery: [{ status: "complete" }],
        },
      },
    },
  });
  expect(snapshotReads).toBe(2);
  await client.close();
});

it("rejects all waiters when the loaded image base changes during derivation", async () => {
  const bytes = nativeAotPeFixture();
  const observation = fixtureDosLoadImage().observation;
  let calls = 0;
  let resolveSnapshot:
    | ((value: Result<GhidraTargetSnapshot, GhidraSessionError>) => void)
    | undefined;
  let markSnapshotStarted: (() => void) | undefined;
  const snapshotStarted = new Promise<void>((resolve) => {
    markSnapshotStarted = resolve;
  });
  const snapshot = new Promise<
    Result<GhidraTargetSnapshot, GhidraSessionError>
  >((resolve) => {
    resolveSnapshot = resolve;
  });
  const factory: GhidraProviderClientFactory = () => ({
    start: () => Promise.resolve(ok(sessionInfo())),
    callTool: () => {
      calls += 1;
      return Promise.resolve(
        ok(
          jsonValueSchema.parse({
            ...observation,
            image_base: calls === 1 ? "0x140000000" : "0x150000000",
          }),
        ),
      );
    },
    readTargetSnapshot: () => {
      markSnapshotStarted?.();
      return snapshot;
    },
    close: () => Promise.resolve(ok(null)),
  });
  const ghidra = provider(installationHost(), factory);
  const target = { ...peTarget("x86_64"), sha256: nativeAotPeDigest(bytes) };
  const profile = await ghidra.resolveAnalysisProfile(target);
  if (!profile.ok || profile.value.profile === null)
    throw new Error("Expected admitted PE profile");
  const client = ghidra.createClient(target, profile.value.profile);
  const originalBase = client.execute("inspect_native_load_image", {});
  await snapshotStarted;
  const changedBase = await client.execute("inspect_native_load_image", {});
  expect(changedBase).toMatchObject({
    ok: false,
    error: {
      _tag: "ProviderAdapterError",
      diagnostics: {
        observed_image_base: "0x150000000",
        measured_observation: { image_base: "0x150000000" },
      },
    },
  });
  resolveSnapshot?.(ok({ kind: "captured", bytes }));
  await expect(originalBase).resolves.toMatchObject({
    ok: false,
    error: {
      _tag: "ProviderAdapterError",
      diagnostics: {
        reason: expect.stringContaining("conflicting loaded image bases"),
        measured_observation: { image_base: "0x140000000" },
        conflicting_observation: { image_base: "0x150000000" },
      },
    },
  });
  expect(calls).toBe(2);
  await client.close();
});

it("cancels an in-flight NativeAOT waiter when its owning session closes", async () => {
  const bytes = nativeAotPeFixture();
  const observations = fixtureDosLoadImage().observation;
  observations.image_base = "0x140000000";
  let resolveSnapshot:
    | ((value: Result<GhidraTargetSnapshot, GhidraSessionError>) => void)
    | undefined;
  let snapshotSignal: AbortSignal | undefined;
  let markSnapshotStarted: (() => void) | undefined;
  const snapshotStarted = new Promise<void>((resolve) => {
    markSnapshotStarted = resolve;
  });
  const snapshot = new Promise<
    Result<GhidraTargetSnapshot, GhidraSessionError>
  >((resolve) => {
    resolveSnapshot = resolve;
  });
  const factory: GhidraProviderClientFactory = () => ({
    start: () => Promise.resolve(ok(sessionInfo())),
    callTool: () => Promise.resolve(ok(jsonValueSchema.parse(observations))),
    readTargetSnapshot: (_maximumBytes, signal) => {
      snapshotSignal = signal;
      markSnapshotStarted?.();
      return snapshot;
    },
    close: () => Promise.resolve(ok(null)),
  });
  const ghidra = provider(installationHost(), factory);
  const target = { ...peTarget("x86_64"), sha256: nativeAotPeDigest(bytes) };
  const profile = await ghidra.resolveAnalysisProfile(target);
  if (!profile.ok || profile.value.profile === null)
    throw new Error("Expected admitted PE profile");
  const client = ghidra.createClient(target, profile.value.profile);
  const pending = client.execute("inspect_native_load_image", {});
  await snapshotStarted;
  await client.close();
  expect(snapshotSignal?.aborted).toBe(true);
  resolveSnapshot?.(ok({ kind: "captured", bytes }));
  await expect(pending).resolves.toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
});

describe("Ghidra NativeAOT snapshot budget", () => {
  it("reports snapshot-capacity omissions inline through the load-image result", async () => {
    const observations = fixtureDosLoadImage().observation;
    const target = peTarget("x86_64");
    const factory: GhidraProviderClientFactory = () => ({
      start: () => Promise.resolve(ok(sessionInfo())),
      callTool: () => Promise.resolve(ok(jsonValueSchema.parse(observations))),
      readTargetSnapshot: () =>
        Promise.resolve(
          ok({
            kind: "over-capacity",
            sourceBytesAtLeast: 128 * 1024 * 1024 + 1,
            maximumBytes: 128 * 1024 * 1024,
          }),
        ),
      close: () => Promise.resolve(ok(null)),
    });
    const ghidra = provider(installationHost(), factory);
    const profile = await ghidra.resolveAnalysisProfile(target);
    if (!profile.ok || profile.value.profile === null)
      throw new Error("Expected admitted PE profile");
    const client = ghidra.createClient(target, profile.value.profile);
    const image = await client.execute("inspect_native_load_image", {});
    expect(image).toMatchObject({
      ok: true,
      value: {
        result: {
          observations: {
            metadata_recovery: [
              {
                status: "partial",
                truncated: true,
                coverage: { truncation_reason: "source-byte-budget" },
              },
            ],
          },
        },
      },
    });
    await client.close();
  });
});

const sessionInfo = () => ({
  name: "REA Ghidra bridge" as const,
  run_id: "11111111-1111-4111-8111-111111111111",
  profile_digest: "a".repeat(64),
  provider: { id: "ghidra" as const, version: "12.1.4" },
  read_only: false as const,
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
  architecture: Extract<BinaryTarget, { format: "pe" }>["architecture"],
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
  architecture: Extract<BinaryTarget, { format: "pe" }>["architecture"],
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

describe("Ghidra extension failures", () => {
  it.each(["unsupported", "failed", "malformed"] as const)(
    "preserves %s recovery diagnostics and closes without restarting",
    async (status) => {
      const directory = await mkdtemp(
        join(tmpdir(), "rea-provider-extension-"),
      );
      try {
        const jar = join(directory, "addon.jar");
        await writeFile(jar, Buffer.from([0x50, 0x4b, 3, 4]));
        const config = parseConfig({
          GHIDRA_INSTALL_DIR: INSTALL,
          REA_GHIDRA_NATIVEAOT_JAR: jar,
        });
        if (!config.ok) throw config.error;
        let starts = 0,
          calls = 0,
          closes = 0;
        const ghidra = new GhidraProvider(
          config.value,
          silentLogger,
          {},
          installationHost(),
          () => ({
            start: () => {
              starts++;
              return Promise.resolve(
                ok({
                  ...sessionInfo(),
                  analysis_extensions: [
                    {
                      id: "nativeaot",
                      sha256:
                        status === "malformed"
                          ? "0".repeat(64)
                          : createHash("sha256")
                              .update(Buffer.from([0x50, 0x4b, 3, 4]))
                              .digest("hex"),
                      status: status === "malformed" ? "failed" : status,
                      reason:
                        "directory-discovery: Unsupported layout at 0x401000",
                      result: {
                        id: "nativeaot",
                        integration_api: 1,
                        source_revision:
                          "effeb734fc570c32650f88b159608979dc7b423e",
                        source_revision_authority: "build-reported-unattested",
                        status: status === "malformed" ? "failed" : status,
                        reason:
                          "directory-discovery: Unsupported layout at 0x401000",
                        method_tables: 0,
                        diagnostics: ["exact producer diagnostic"],
                      },
                    },
                  ],
                }),
              );
            },
            callTool: () => {
              calls++;
              return Promise.resolve(ok(null));
            },
            close: () => {
              closes++;
              return Promise.resolve(ok(null));
            },
          }),
        );
        const target = executableTarget("elf", "x86_64");
        const resolved = await ghidra.resolveAnalysisProfile(target);
        if (!resolved.ok || resolved.value.profile === null)
          throw new Error("expected extension profile");
        const client = ghidra.createClient(target, resolved.value.profile);
        const failed = await client.execute("health", {});
        expect(failed.ok).toBe(false);
        if (!failed.ok) {
          expect(failed.error._tag).toBe(
            status === "unsupported"
              ? "AnalysisCapabilityUnavailableError"
              : "ProviderAdapterError",
          );
          expect(JSON.stringify(failed.error)).toContain(
            status === "malformed"
              ? "identity mismatch"
              : "Unsupported layout at 0x401000",
          );
        }
        expect(await client.execute("list_procedures", {})).toEqual(failed);
        expect({ starts, calls, closes }).toEqual({
          starts: 1,
          calls: 0,
          closes: 1,
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

describe("compatible Ghidra builds", () => {
  it("accepts the build and reports that it is unverified", async () => {
    const ghidra = provider(
      {
        ...installationHost(),
        readText: () =>
          "application.version=12.1.2\napplication.java.min=21\napplication.java.max=\n",
        probeJava: () => ({
          version: "27",
          major: 27,
          home: "/usr/lib/jvm/java-27-openjdk",
          bits: 64,
          runtime: "jdk",
        }),
      },
      () => ({
        start: () =>
          Promise.resolve(
            ok({
              ...sessionInfo(),
              provider: { id: "ghidra", version: "12.1.2" },
            }),
          ),
        callTool: () =>
          Promise.resolve(
            ok([
              {
                address: "0x1000",
                value: "fixture_main",
                procedure: {
                  external: false,
                  thunk: false,
                  thunk_target: null,
                },
              },
            ]),
          ),
        close: () => Promise.resolve(ok(null)),
      }),
    );
    const resolved = await ghidra.resolveAnalysisProfile(
      executableTarget("elf", "x86_64"),
    );
    if (!resolved.ok || resolved.value.profile === null)
      throw new Error("expected a compatible Ghidra profile");
    const client = ghidra.createClient(
      executableTarget("elf", "x86_64"),
      resolved.value.profile,
    );
    const health = await client.execute("health", {});
    const procedures = await client.execute("list_procedures", {});
    expect(ghidra.inspectAvailability()).toMatchObject({
      status: "available",
      diagnostics: { provider_version: "12.1.2", java_version: "27" },
    });
    expect(health.ok && health.value.provider.version).toBe("12.1.2");
    const unverified = expect.stringContaining("12.1.2");
    expect(health.ok && health.value.limitations).toEqual(
      expect.arrayContaining([unverified]),
    );
    expect(procedures.ok && procedures.value.limitations).toEqual(
      expect.arrayContaining([unverified]),
    );
    expect(procedures.ok && procedures.value.provider.version).toBe("12.1.2");
  });
});

it("projects Ghidra startup failure and its incomplete cleanup together", async () => {
  const cleanup = new ProviderCleanupError("ghidra", ["owned-ghidra-process"], {
    reason: "process cleanup unconfirmed",
  });
  const ghidra = provider(installationHost(), () => ({
    start: async () =>
      err(
        new GhidraSessionError(
          "timeout",
          "Ghidra startup deadline elapsed",
          { failure_kind: "timeout" },
          { timeoutMs: 250, cleanupFailure: cleanup },
        ),
      ),
    callTool: async () => ok(null),
    close: async () => err(cleanup),
  }));
  const target = executableTarget("elf", "x86_64");
  const profile = await ghidra.resolveAnalysisProfile(target);
  if (!profile.ok || profile.value.profile === null)
    throw new Error("Expected Ghidra analysis profile");
  const result = await ghidra
    .createClient(target, profile.value.profile)
    .execute("health", {});
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        resources: ["owned-ghidra-process"],
        diagnostics: {
          primary_error: {
            code: "provider_timeout",
            details: {
              timeout_ms: 250,
              diagnostics: { failure_kind: "timeout" },
            },
          },
          cleanup_error: { code: "cleanup_incomplete" },
        },
      },
    });
});

describe("Ghidra analysis seeds and configured language", () => {
  const seedSession = async (
    report: (sha256: string) => GhidraSeedReport | undefined,
  ) => {
    const directory = await mkdtemp(join(tmpdir(), "rea-provider-seeds-"));
    const seeds = join(directory, "seeds.tsv");
    await writeFile(seeds, "0x401000\tfunction\tentry\n0x401010\tcode\n");
    const config = parseConfig({
      GHIDRA_INSTALL_DIR: INSTALL,
      REA_GHIDRA_SEED_FILE: seeds,
    });
    if (!config.ok) throw config.error;
    const counts = { starts: 0, calls: 0, closes: 0 };
    const ghidra = new GhidraProvider(
      config.value,
      silentLogger,
      {},
      installationHost(),
      () => ({
        start: () => {
          counts.starts++;
          const seedReport = report(
            createHash("sha256")
              .update("0x401000\tfunction\tentry\n0x401010\tcode\n")
              .digest("hex"),
          );
          return Promise.resolve(
            ok({
              ...sessionInfo(),
              ...(seedReport === undefined
                ? {}
                : { analysis_seeds: seedReport }),
            }),
          );
        },
        callTool: () => {
          counts.calls++;
          return Promise.resolve(ok(null));
        },
        close: () => {
          counts.closes++;
          return Promise.resolve(ok(null));
        },
      }),
    );
    const target = executableTarget("elf", "x86_64");
    const resolved = await ghidra.resolveAnalysisProfile(target);
    if (!resolved.ok || resolved.value.profile === null)
      throw new Error("expected seed profile");
    return {
      directory,
      counts,
      client: ghidra.createClient(target, resolved.value.profile),
    };
  };
  const applied = (sha256: string): GhidraSeedReport => ({
    format: "rea-ghidra-seeds-v1",
    sha256,
    entries: 2,
    function_created: 1,
    function_existing: 0,
    function_failed: 0,
    code_decoded: 0,
    code_failed: 1,
    label_applied: 0,
    label_failed: 0,
    unmapped: 0,
  });

  it("reports the verified seed outcome as a session limitation", async () => {
    const { directory, client } = await seedSession(applied);
    try {
      const health = await client.execute("health", {});
      if (!health.ok) throw health.error;
      expect(health.value.limitations).toEqual(
        expect.arrayContaining([
          expect.stringContaining("caller assertions, not Ghidra discoveries"),
          expect.stringContaining(
            "1 functions created, 0 already present, 0 failed; 0 code seeds decoded, 1 failed",
          ),
        ]),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["no seed report", () => undefined],
    [
      "a report for other seeds",
      (sha256: string): GhidraSeedReport => ({
        ...applied(sha256),
        sha256: "0".repeat(64),
      }),
    ],
  ])("fails closed on %s before any analysis call", async (_label, report) => {
    const { directory, counts, client } = await seedSession(report);
    try {
      const failed = await client.execute("list_procedures", {});
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.error._tag).toBe("ProviderAdapterError");
      expect(counts).toEqual({ starts: 1, calls: 0, closes: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a profile resolved without the configured seeds or language", async () => {
    const plain = parseConfig({ GHIDRA_INSTALL_DIR: INSTALL });
    if (!plain.ok) throw plain.error;
    const target = executableTarget("elf", "x86_64");
    const resolved = await new GhidraProvider(
      plain.value,
      silentLogger,
      {},
      installationHost(),
    ).resolveAnalysisProfile(target);
    if (!resolved.ok || resolved.value.profile === null)
      throw new Error("expected profile");
    for (const environment of [
      { REA_GHIDRA_SEED_FILE: "/seeds.tsv" },
      { REA_GHIDRA_LANGUAGE_ID: "x86:LE:32:default" },
    ]) {
      const configured = parseConfig({
        GHIDRA_INSTALL_DIR: INSTALL,
        ...environment,
      });
      if (!configured.ok) throw configured.error;
      let starts = 0;
      const client = new GhidraProvider(
        configured.value,
        silentLogger,
        {},
        installationHost(),
        () => ({
          start: () => {
            starts++;
            return Promise.resolve(ok(sessionInfo()));
          },
          callTool: () => Promise.resolve(ok(null)),
          close: () => Promise.resolve(ok(null)),
        }),
      ).createClient(target, resolved.value.profile);
      const failed = await client.execute("health", {});
      expect(failed.ok).toBe(false);
      expect(starts).toBe(0);
    }
  });
});

describe("Ghidra disabled analyzer options", () => {
  const configuredProvider = (
    environment: Record<string, string>,
    clientFactory?: GhidraProviderClientFactory,
  ) => {
    const config = parseConfig({ GHIDRA_INSTALL_DIR: INSTALL, ...environment });
    if (!config.ok) throw config.error;
    return new GhidraProvider(
      config.value,
      silentLogger,
      {},
      installationHost(),
      clientFactory,
    );
  };

  it("records the configured analyzer options in the analysis profile", async () => {
    const ghidra = configuredProvider({
      REA_GHIDRA_DISABLED_ANALYZERS:
        "Objective-C Message Analyzer,Decompiler Switch Analysis",
    });
    const resolved = await ghidra.resolveAnalysisProfile(
      executableTarget("elf", "x86_64"),
    );
    if (!resolved.ok || resolved.value.profile === null)
      throw new Error("expected a bound Ghidra profile");
    expect(resolved.value.profile.parameters).toMatchObject({
      analyzer_preset:
        "ghidra-default+disabled:Objective-C Message Analyzer,Decompiler Switch Analysis",
      analysis_options: {
        disabled_analyzers: [
          "Objective-C Message Analyzer",
          "Decompiler Switch Analysis",
        ],
      },
    });
  });

  it("hands the configured analyzers to the launcher for a matching profile", async () => {
    const launchers: GhidraHeadlessLauncher[] = [];
    const ghidra = configuredProvider(
      { REA_GHIDRA_DISABLED_ANALYZERS: "Objective-C Message Analyzer" },
      (options) => {
        launchers.push(options.launcher as GhidraHeadlessLauncher);
        return {
          start: () => Promise.resolve(ok(sessionInfo())),
          callTool: () => Promise.resolve(ok(null)),
          close: () => Promise.resolve(ok(null)),
        };
      },
    );
    const target = executableTarget("elf", "x86_64");
    const resolved = await ghidra.resolveAnalysisProfile(target);
    if (!resolved.ok || resolved.value.profile === null)
      throw new Error("expected a bound Ghidra profile");
    const client = ghidra.createClient(target, resolved.value.profile);
    const health = await client.execute("health", {});
    expect(health.ok).toBe(true);
    expect(launchers).toHaveLength(1);
    expect(launchers[0]?.options.disabledAnalyzers).toEqual([
      "Objective-C Message Analyzer",
    ]);
  });

  it("binds analyzer overrides and raw import settings in one profile", async () => {
    const launchers: GhidraHeadlessLauncher[] = [];
    const ghidra = configuredProvider(
      { REA_GHIDRA_DISABLED_ANALYZERS: "Decompiler Switch Analysis" },
      (options) => {
        launchers.push(options.launcher as GhidraHeadlessLauncher);
        return {
          start: () => Promise.resolve(ok(sessionInfo())),
          callTool: () => Promise.resolve(ok(null)),
          close: () => Promise.resolve(ok(null)),
        };
      },
    );
    const target: BinaryTarget = {
      path: "/tmp/entry.bin",
      sha256: "a".repeat(64),
      kind: "executable",
      format: "raw-binary",
      architecture: "x86",
      availableArchitectures: ["x86"],
      entryPoint: "0x1000",
      entryPointSource: "0x1000",
    };
    const resolved = await ghidra.resolveAnalysisProfile(target);
    if (!resolved.ok || resolved.value.profile === null)
      throw new Error("expected a bound raw-binary profile");
    expect(resolved.value.profile.parameters).toMatchObject({
      target_format: "raw-binary",
      entry_point: "0x1000",
      analyzer_preset: "ghidra-default+disabled:Decompiler Switch Analysis",
      analysis_options: { disabled_analyzers: ["Decompiler Switch Analysis"] },
    });
    const client = ghidra.createClient(target, resolved.value.profile);
    expect(launchers).toHaveLength(1);
    expect(launchers[0]?.options).toMatchObject({
      disabledAnalyzers: ["Decompiler Switch Analysis"],
      rawBinary: {
        languageId: "x86:LE:32:default",
        compilerSpecId: "gcc",
        baseAddr: "0x1000",
      },
    });
    await client.close();
  });

  it("refuses a profile resolved without or with other analyzer options", async () => {
    const target = executableTarget("elf", "x86_64");
    const plainProvider = configuredProvider({});
    const plain = await plainProvider.resolveAnalysisProfile(target);
    if (!plain.ok || plain.value.profile === null)
      throw new Error("expected profile");
    const configuredProvider2 = configuredProvider({
      REA_GHIDRA_DISABLED_ANALYZERS: "Objective-C Message Analyzer",
    });
    const configured = await configuredProvider2.resolveAnalysisProfile(target);
    if (!configured.ok || configured.value.profile === null)
      throw new Error("expected configured profile");
    for (const [profile, environment] of [
      [
        plain.value.profile,
        { REA_GHIDRA_DISABLED_ANALYZERS: "Objective-C Message Analyzer" },
      ],
      [configured.value.profile, {}],
      [
        configured.value.profile,
        { REA_GHIDRA_DISABLED_ANALYZERS: "Decompiler Switch Analysis" },
      ],
    ] as const) {
      let starts = 0;
      const client = configuredProvider(environment, () => ({
        start: () => {
          starts++;
          return Promise.resolve(ok(sessionInfo()));
        },
        callTool: () => Promise.resolve(ok(null)),
        close: () => Promise.resolve(ok(null)),
      })).createClient(target, profile);
      const failed = await client.execute("health", {});
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.error._tag).toBe("ProviderAdapterError");
      expect(starts).toBe(0);
    }
  });
});
