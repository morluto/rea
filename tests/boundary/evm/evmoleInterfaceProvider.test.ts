import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { evmInterfaceSchema } from "../../../src/domain/evm/evmInterface.js";
import { EvmoleInterfaceProvider } from "../../../src/evm/EvmoleInterfaceProvider.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { waitForProviderProcessReady } from "../../fixtures/providerProcess.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

const unsupportedHost = process.platform !== "linux" || process.arch !== "x64";
const requestSchema = z.strictObject({
  snapshot_path: z.string(),
  reply_path: z.string(),
  failure_marker_path: z.string(),
  encoding: z.enum(["raw", "hex"]),
});
const fixture = async () => {
  const workspace = await createTestWorkspace("rea-evm-interface-boundary-");
  onTestFinished(() => removeTestWorkspace(workspace.root));
  const path = join(workspace.root, "selected.hex");
  await writeFile(path, "0x60006000f3\n");
  return { path, root: workspace.root };
};

it.runIf(!unsupportedHost).each(["SIGXCPU", "SIGXFSZ", "EFBIG"])(
  "preserves %s with configured limits distinct from unknown effective limits",
  async (failure) => {
    const { path } = await fixture();
    let ownedPath = "";
    const provider = new EvmoleInterfaceProvider({}, async (spawn) => {
      ownedPath = spawn.cwd ?? "";
      if (failure === "EFBIG")
        await writeFile(join(ownedPath, "resource.failure"), "F");
      return spawnOwnedProviderProcess({
        ...spawn,
        command: process.execPath,
        arguments: [
          "-e",
          failure === "EFBIG"
            ? 'process.stdout.write("resource diagnostic", () => { process.exitCode = 76; })'
            : failure === "SIGXFSZ"
              ? 'process.on("SIGXFSZ", () => { process.removeAllListeners("SIGXFSZ"); process.kill(process.pid, "SIGXFSZ"); }); process.stdout.write("resource diagnostic", () => process.kill(process.pid, "SIGXFSZ")); setTimeout(() => {}, 1000);'
              : `process.stdout.write("resource diagnostic", () => process.kill(process.pid, "${failure}"))`,
        ],
      });
    });
    const result = await provider.inspect({ path, encoding: "hex" });
    if (result.ok) throw new Error("Expected observed resource failure");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "resource_constraint",
      details: {
        resource: failure === "SIGXCPU" ? "cpu" : "file-size",
        reported_limits: {
          configured_soft_limits: { cpu_seconds: expect.any(Number) },
          effective_soft_limits: null,
        },
        captured_output: { stdout: "resource diagnostic", truncated: false },
      },
    });
    expect(result.error.message).toContain(
      failure === "EFBIG" ? "exact write failure cause" : "exact signal cause",
    );
    await expect(access(ownedPath)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.runIf(!unsupportedHost).each(["missing", "wrong"])(
  "does not classify a launcher exit 76 with %s worker failure evidence",
  async (scenario) => {
    const { path } = await fixture();
    let ownedPath = "";
    const provider = new EvmoleInterfaceProvider({}, async (spawn) => {
      ownedPath = spawn.cwd ?? "";
      if (scenario === "wrong")
        await writeFile(
          join(ownedPath, "resource.failure"),
          Buffer.from([0xc6]),
        );
      return spawnOwnedProviderProcess({
        ...spawn,
        command: process.execPath,
        arguments: [
          "-e",
          'process.stdout.write("launcher failure", () => { process.exitCode = 76; });',
        ],
      });
    });
    const result = await provider.inspect({ path, encoding: "hex" });
    if (result.ok) throw new Error("Expected launcher failure");
    expect(projectAnalysisError(result.error).code).toBe("execution_failure");
    expect(result.error).toMatchObject({
      diagnostics: {
        file_size_failure_marker: {
          verified: false,
          failure: expect.any(String),
        },
        captured_output: { stdout: "launcher failure", truncated: false },
      },
    });
    await expect(access(ownedPath)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.runIf(!unsupportedHost)(
  "retains actual diagnostic truncation when overflow and process cleanup both fail",
  async () => {
    const { path } = await fixture();
    let ownedPath = "";
    const provider = new EvmoleInterfaceProvider({}, async (spawn) => {
      ownedPath = spawn.cwd ?? "";
      const launched = await spawnOwnedProviderProcess({
        ...spawn,
        command: process.execPath,
        arguments: ["-e", 'process.stdout.write("x".repeat(1048577))'],
      });
      return {
        ...launched,
        cleanup: async () => {
          await launched.cleanup?.();
          throw new Error("injected post-cleanup reporting failure");
        },
      };
    });
    const result = await provider.inspect({ path, encoding: "hex" });
    if (result.ok) throw new Error("Expected compounded lifecycle failure");
    expect(result.error).toMatchObject({
      cleanupIncomplete: true,
      diagnostics: {
        reason: "injected post-cleanup reporting failure",
        previous_error: { failure_kind: "output-limit" },
        captured_output: { truncated: true, stderr: "" },
      },
    });
    await expect(access(ownedPath)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.runIf(!unsupportedHost).each([1048576, 1048577])(
  "keeps complete diagnostics or rejects a valid worker reply with %s diagnostic bytes",
  async (size) => {
    const { path } = await fixture();
    let ownedPath = "";
    const provider = new EvmoleInterfaceProvider({}, async (spawn) => {
      ownedPath = spawn.cwd ?? "";
      const requestPath = spawn.arguments.at(-1);
      if (requestPath === undefined) throw new Error("Request missing");
      const request = requestSchema.parse(
        JSON.parse(await readFile(requestPath, "utf8")),
      );
      const bytes = Buffer.from("60006000f3", "hex");
      await writeFile(
        request.reply_path,
        JSON.stringify({
          ok: true,
          version: "0.9.3",
          bytecode: {
            sha256: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.length,
            hex: bytes.toString("hex"),
          },
          raw: { functions: [] },
        }),
      );
      return spawnOwnedProviderProcess({
        ...spawn,
        command: process.execPath,
        arguments: ["-e", `process.stderr.write("x".repeat(${String(size)}))`],
      });
    });
    const result = await provider.inspect({ path, encoding: "hex" });
    if (size === 1048576) {
      if (!result.ok) throw result.error;
      const report = evmInterfaceSchema.parse(result.value.result);
      expect(report.diagnostics.stderr).toHaveLength(size);
      expect(report.diagnostics.truncated).toBe(false);
    } else {
      if (result.ok)
        throw new Error("Expected explicit diagnostic budget failure");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "unreadable_output",
        details: { captured_output: { truncated: true } },
      });
    }
    await expect(access(ownedPath)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it
  .runIf(!unsupportedHost)
  .each([
    "success",
    "format",
    "unsupported",
    "wrong-version",
    "wrong-decoded-carrier",
    "broken-reply",
    "out-of-range-body",
  ])(
  "binds source carrier/worker representation and releases owned files: %s",
  async (scenario) => {
    const { path } = await fixture();
    let ownedRoot = "";
    const provider = new EvmoleInterfaceProvider(
      { NODE_OPTIONS: "--inspect=0" },
      async (spawn) => {
        ownedRoot = spawn.cwd ?? "";
        expect(spawn.hostEnvironment?.NODE_OPTIONS).toBeUndefined();
        expect(spawn.arguments).toContain("--as=3221225472:");
        expect(spawn.arguments).toContain("--disable-wasm-trap-handler");
        const requestPath = spawn.arguments.at(-1);
        if (requestPath === undefined) throw new Error("request missing");
        const request = requestSchema.parse(
          JSON.parse(await readFile(requestPath, "utf8")),
        );
        expect(request.encoding).toBe("hex");
        expect(await readFile(request.snapshot_path, "utf8")).toBe(
          "0x60006000f3\n",
        );
        const hex = scenario === "wrong-decoded-carrier" ? "00" : "60006000f3";
        const bytes = Buffer.from(hex, "hex");
        await writeFile(
          request.reply_path,
          scenario === "broken-reply"
            ? "broken"
            : JSON.stringify(
                ["format", "unsupported"].includes(scenario)
                  ? {
                      ok: false,
                      reason: scenario,
                      message: "Malformed hex carrier.",
                    }
                  : {
                      ok: true,
                      version: scenario === "wrong-version" ? "0.0.0" : "0.9.3",
                      bytecode: {
                        sha256: createHash("sha256")
                          .update(bytes)
                          .digest("hex"),
                        bytes: bytes.length,
                        hex,
                      },
                      raw: {
                        functions:
                          scenario === "out-of-range-body"
                            ? [
                                {
                                  selector: "aabbccdd",
                                  bytecodeOffset: 5,
                                  dispatch: "abi",
                                },
                              ]
                            : [],
                      },
                    },
              ),
        );
        return spawnOwnedProviderProcess({
          ...spawn,
          command: process.execPath,
          arguments: ["-e", 'process.stderr.write("upstream warning")'],
        });
      },
    );
    const result = await provider.inspect({ path, encoding: "hex" });
    if (scenario === "success") {
      if (!result.ok) throw result.error;
      expect(result.value.result).toMatchObject({
        artifact: { path, encoding: "hex", bytes: 13 },
        bytecode: { hex: "60006000f3", bytes: 5 },
        diagnostics: { stderr: "upstream warning" },
      });
      expect(result.value.rawResult).toEqual({ functions: [] });
    } else
      expect(result).toMatchObject({
        ok: false,
        error: {
          _tag:
            scenario === "format"
              ? "AnalysisInputError"
              : scenario === "unsupported"
                ? "AnalysisUnsupportedTargetError"
                : "AnalysisOutputError",
        },
      });
    if (!result.ok)
      expect(projectAnalysisError(result.error)).toMatchObject({
        details: {
          captured_output: {
            stdout: "",
            stderr: "upstream warning",
            truncated: false,
          },
        },
      });
    expect(await readFile(path, "utf8")).toBe("0x60006000f3\n");
    await expect(access(ownedRoot)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.runIf(!unsupportedHost).each(["cancelled", "output-limit", "process"])(
  "preserves lifecycle failure and independently releases an acquired worker: %s",
  async (scenario) => {
    const { path } = await fixture();
    const controller = new AbortController();
    let pid: number | undefined;
    let ownedRoot = "";
    const provider = new EvmoleInterfaceProvider({}, async (spawn) => {
      ownedRoot = spawn.cwd ?? "";
      const launched = await spawnOwnedProviderProcess({
        ...spawn,
        command: process.execPath,
        arguments: [
          "-e",
          scenario === "cancelled"
            ? 'process.stdout.write("ready\\n");setInterval(()=>undefined,1000)'
            : scenario === "output-limit"
              ? 'process.stdout.write("x".repeat(1048577))'
              : 'process.stderr.write("worker failed");process.exit(7)',
        ],
      });
      pid = launched.process.pid;
      if (scenario === "cancelled") {
        await waitForProviderProcessReady(launched.process);
        setImmediate(() => controller.abort());
      }
      return launched;
    });
    expect(
      await provider.inspect(
        { path, encoding: "hex" },
        { signal: controller.signal },
      ),
    ).toMatchObject({
      ok: false,
      error: {
        _tag:
          scenario === "cancelled"
            ? "AnalysisCancelledError"
            : scenario === "output-limit"
              ? "AnalysisOutputError"
              : "ProviderAdapterError",
      },
    });
    if (pid === undefined) throw new Error("worker not acquired");
    const acquiredPid = pid;
    expect(() => process.kill(acquiredPid, 0)).toThrow();
    await expect(access(ownedRoot)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.runIf(!unsupportedHost)(
  "distinguishes unavailable limiter, absent carrier and prelaunch cancellation",
  async () => {
    const { path } = await fixture();
    expect(
      await new EvmoleInterfaceProvider({
        REA_EVM_PRLIMIT_COMMAND: path + ".absent",
      }).inspect({ path, encoding: "hex" }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCapabilityUnavailableError" },
    });
    expect(
      await new EvmoleInterfaceProvider({}).inspect({
        path: path + ".absent",
        encoding: "raw",
      }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
    const controller = new AbortController();
    controller.abort();
    expect(
      await new EvmoleInterfaceProvider({}).inspect(
        { path, encoding: "raw" },
        { signal: controller.signal },
      ),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
  },
);
it.runIf(unsupportedHost)(
  "reports unverified host coverage before acquiring a provider",
  async () => {
    expect(
      await new EvmoleInterfaceProvider({}).inspect({
        path: "/selected.hex",
        encoding: "hex",
      }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCapabilityUnavailableError" },
    });
  },
);

it.runIf(!unsupportedHost)(
  "preserves actual snapshot-write cancellation and root cleanup",
  async () => {
    const { path } = await fixture();
    const controller = new AbortController();
    let ownedRoot = "";
    const provider = new EvmoleInterfaceProvider(
      {},
      () => {
        throw new Error("must not launch worker");
      },
      async () => {
        const root = await PrivateRuntimeRoot.create({
          prefix: "rea-evm-cancel-",
        });
        ownedRoot = root.path;
        controller.abort();
        return root;
      },
    );
    expect(
      await provider.inspect(
        { path, encoding: "hex" },
        { signal: controller.signal },
      ),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
    await expect(access(ownedRoot)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.runIf(!unsupportedHost)(
  "reports private storage denial without claiming selected carrier read denial",
  async () => {
    const { path } = await fixture();
    const provider = new EvmoleInterfaceProvider({}, undefined, () =>
      Promise.reject(
        Object.assign(new Error("private root denied"), { code: "EACCES" }),
      ),
    );
    expect(await provider.inspect({ path, encoding: "hex" })).toMatchObject({
      ok: false,
      error: {
        _tag: "ProviderAdapterError",
        diagnostics: { phase: "worker", reason: "private root denied" },
      },
    });
  },
);

it.runIf(!unsupportedHost)(
  "retains original format failure when owned-root cleanup fails",
  async () => {
    const { path, root } = await fixture();
    const provider = new EvmoleInterfaceProvider(
      {},
      async (spawn) => {
        const requestPath = spawn.arguments.at(-1);
        if (requestPath === undefined) throw new Error("request missing");
        const request = requestSchema.parse(
          JSON.parse(await readFile(requestPath, "utf8")),
        );
        await writeFile(
          request.reply_path,
          JSON.stringify({
            ok: false,
            reason: "format",
            message: "Odd selected hex.",
          }),
        );
        return spawnOwnedProviderProcess({
          ...spawn,
          command: process.execPath,
          arguments: ["-e", "process.exit(0)"],
        });
      },
      () =>
        Promise.resolve({
          path: root,
          close: () => Promise.reject(new Error("root cleanup failed")),
        }),
    );
    expect(await provider.inspect({ path, encoding: "hex" })).toMatchObject({
      ok: false,
      error: {
        cleanupIncomplete: true,
        cleanupResources: [root],
        diagnostics: {
          reason: "root cleanup failed",
          previous_error: { category: "invalid_input" },
        },
      },
    });
  },
);

it.runIf(!unsupportedHost).each(["late-cancellation", "cleanup-failure"])(
  "retains captured warnings after a successful worker: %s",
  async (scenario) => {
    const { path } = await fixture();
    const controller = new AbortController();
    let ownedRoot = "";
    const provider = new EvmoleInterfaceProvider(
      {},
      async (spawn) => {
        const requestPath = spawn.arguments.at(-1);
        if (requestPath === undefined) throw new Error("request missing");
        const request = requestSchema.parse(
          JSON.parse(await readFile(requestPath, "utf8")),
        );
        const bytes = Buffer.from("60006000f3", "hex");
        await writeFile(
          request.reply_path,
          JSON.stringify({
            ok: true,
            version: "0.9.3",
            bytecode: {
              sha256: createHash("sha256").update(bytes).digest("hex"),
              bytes: bytes.length,
              hex: bytes.toString("hex"),
            },
            raw: { functions: [] },
          }),
        );
        return spawnOwnedProviderProcess({
          ...spawn,
          command: process.execPath,
          arguments: ["-e", 'process.stderr.write("upstream warning")'],
        });
      },
      async () => {
        const root = await PrivateRuntimeRoot.create({
          prefix: "rea-evm-late-",
        });
        ownedRoot = root.path;
        return {
          path: root.path,
          close: async () => {
            await root.close();
            if (scenario === "late-cancellation") controller.abort();
            else throw new Error("reported cleanup failure");
          },
        };
      },
    );
    const result = await provider.inspect(
      { path, encoding: "hex" },
      { signal: controller.signal },
    );
    if (result.ok) throw new Error("Expected lifecycle failure");
    const output = { stdout: "", stderr: "upstream warning", truncated: false };
    expect(projectAnalysisError(result.error)).toMatchObject({
      category:
        scenario === "late-cancellation" ? "cancelled" : "execution_failure",
      details:
        scenario === "late-cancellation"
          ? { captured_output: output }
          : { diagnostics: { captured_output: output } },
    });
    await expect(access(ownedRoot)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.runIf(!unsupportedHost).each(["directory", "missing-interpreter"])(
  "identifies configured limiter constraints without blaming the carrier: %s",
  async (scenario) => {
    const { path, root } = await fixture();
    const limiter =
      scenario === "directory" ? root : join(root, "broken-limiter");
    if (scenario === "missing-interpreter")
      await writeFile(limiter, "#!/rea-missing-limiter-interpreter\n", {
        mode: 0o700,
      });
    let ownedRoot: string | undefined;
    const provider = new EvmoleInterfaceProvider(
      { REA_EVM_PRLIMIT_COMMAND: limiter },
      undefined,
      async () => {
        const runtime = await PrivateRuntimeRoot.create({
          prefix: "rea-evm-limiter-",
        });
        ownedRoot = runtime.path;
        return runtime;
      },
    );
    const result = await provider.inspect({ path, encoding: "hex" });
    if (result.ok) throw new Error("Expected unavailable limiter");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "capability_unavailable",
      category: "unsupported_provider",
      details: { provider_id: "evmole-interface" },
    });
    expect(result.error.message).toContain(limiter);
    if (ownedRoot !== undefined)
      await expect(access(ownedRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path, "utf8")).toBe("0x60006000f3\n");
  },
);
