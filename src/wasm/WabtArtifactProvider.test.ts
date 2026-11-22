import { spawnFailure } from "../../tests/support/process/spawnFailure.js";
import { createHash } from "node:crypto";
import { access, chmod, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { WabtArtifactProvider } from "./WabtArtifactProvider.js";
import { WasmArtifactService } from "../application/wasm/WasmArtifactService.js";
import {
  wasmArtifactSchema,
  WASM_RESOURCE_DEFAULTS,
} from "../domain/wasm/wasmArtifact.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { PrivateRuntimeRootUnavailableError } from "../domain/privateRuntimeRootUnavailableError.js";
import { spawnOwnedProviderProcess } from "../process/ProviderProcess.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { primaryAnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { admitWabtVersion, WABT_ACCEPTED_RANGE } from "./WabtRelease.js";

/** Classify a raw failure the way the provider does, through WABT's dialect. */
const wabtFailure = (
  cause: unknown,
  ...dialect: Parameters<typeof wabtFailureDialect>
) => classifyProviderFailure(cause, wabtFailureDialect(...dialect));

// Admission must not outrun the `1.0.x` banners wasmArtifactSchema accepts.
it("admits 1.0.x releases but not the 1.1.0 upper boundary", () => {
  expect(WABT_ACCEPTED_RANGE).toBe(">=1.0.42 <1.1.0");
  expect(admitWabtVersion("1.0.41").status).toBe("unsupported");
  expect(admitWabtVersion("1.0.42").status).toBe("verified");
  expect(admitWabtVersion("1.0.99").status).toBe("compatible");
  expect(admitWabtVersion("1.1.0").status).toBe("unsupported");
  expect(admitWabtVersion("2.0.0").status).toBe("unsupported");
});
import { wabtFailureDialect } from "./WabtFailures.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";

const nodeHostEnvironment = (
  environment: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv => ({
  ...environment,
  // Node's Windows CSPRNG initialization requires SystemRoot; the captured
  // provider environment intentionally omits unrelated host variables.
  ...(process.env.SystemRoot === undefined
    ? {}
    : { SystemRoot: process.env.SystemRoot }),
});

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : left === right;
}

const fileCloseFailure = vi.hoisted(() => ({
  selectedPath: "",
  attempts: 0,
  failFirst: false,
  toolCloseFailures: new Set<string>(),
  failRead: undefined as (() => Error) | undefined,
  abortSnapshotWrite: undefined as AbortController | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      const [, , options] = args;
      const abort = fileCloseFailure.abortSnapshotWrite;
      // The provider's private snapshot is the only exclusive (wx) write.
      if (
        abort !== undefined &&
        typeof options === "object" &&
        options?.flag === "wx"
      ) {
        fileCloseFailure.abortSnapshotWrite = undefined;
        abort.abort({ source: "caller cancelled the snapshot write" });
      }
      return fs.writeFile(...args);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const toolPath = [...fileCloseFailure.toolCloseFailures].find((path) =>
        samePath(String(args[0]), path),
      );
      if (toolPath !== undefined) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          if (fileCloseFailure.toolCloseFailures.delete(toolPath))
            throw new Error("injected WABT tool close failure");
          return close();
        };
        return handle;
      }
      if (!samePath(String(args[0]), fileCloseFailure.selectedPath))
        return handle;
      const close = handle.close.bind(handle);
      const failure = fileCloseFailure.failRead;
      if (failure !== undefined) {
        fileCloseFailure.failRead = undefined;
        vi.spyOn(handle, "stat").mockImplementationOnce(() => {
          throw failure();
        });
      }
      handle.close = async () => {
        fileCloseFailure.attempts += 1;
        if (fileCloseFailure.failFirst) {
          fileCloseFailure.failFirst = false;
          throw new Error("injected WABT input close failure");
        }
        return close();
      };
      return handle;
    },
  };
});

const outcomeModes = [
  "success",
  "invalid-close",
  "invalid-close-failure",
  "snapshot-close-failure",
  "snapshot-read-failure-late-abort",
  "malformed",
  "malformed-close",
  "malformed-close-failure",
  "cancelled",
  "cancelled-close",
  "cancelled-close-failure",
  "cleanup",
  "changed-snapshot",
  "malformed-wat",
  "wat-warning",
] as const;
type OutcomeMode = (typeof outcomeModes)[number];

const failureTags: Readonly<Record<Exclude<OutcomeMode, "success">, string>> = {
  "invalid-close": "AnalysisInputError",
  "invalid-close-failure": "ProviderAdapterError",
  "snapshot-close-failure": "AnalysisOutputError",
  "snapshot-read-failure-late-abort": "AnalysisOutputError",
  cancelled: "AnalysisCancelledError",
  "cancelled-close": "AnalysisCancelledError",
  "cancelled-close-failure": "ProviderAdapterError",
  "changed-snapshot": "AnalysisArtifactChangedError",
  cleanup: "ProviderAdapterError",
  malformed: "AnalysisOutputError",
  "malformed-close": "AnalysisOutputError",
  "malformed-close-failure": "ProviderAdapterError",
  "malformed-wat": "AnalysisOutputError",
  "wat-warning": "AnalysisOutputError",
};

const assertCleanupRecovery = async (options: {
  readonly provider: WabtArtifactProvider;
  readonly result: Awaited<ReturnType<WabtArtifactProvider["inspect"]>>;
  readonly path: string;
  readonly runtimePath: string;
  readonly cleanupAttempts: () => number;
  readonly runtimeCreations: () => number;
}): Promise<void> => {
  expect(options.result).toMatchObject({
    error: {
      cleanupIncomplete: true,
      cleanupResources: [options.runtimePath],
      partialObservation: { normalized_result: { validation: "valid" } },
    },
  });
  await expect(access(options.runtimePath)).resolves.toBeUndefined();
  const blocked = await options.provider.inspect({
    path: options.path,
    glue_paths: [],
    candidate_paths: [],
  });
  expect(blocked).toMatchObject({
    ok: false,
    error: {
      cleanupIncomplete: true,
      cleanupResources: [options.runtimePath],
    },
  });
  expect(options.cleanupAttempts()).toBe(2);
  expect(options.runtimeCreations()).toBe(1);
  await options.provider.close();
  expect(options.cleanupAttempts()).toBe(3);
  await expect(access(options.runtimePath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(options.result).toMatchObject({
    error: { cleanupIncomplete: false, cleanupResources: [] },
  });
  expect(blocked).toMatchObject({
    error: { cleanupIncomplete: false, cleanupResources: [] },
  });
};

const assertCancellationDuringRootRelease = async (options: {
  readonly mode: "cancelled-close" | "cancelled-close-failure";
  readonly result: Awaited<ReturnType<WabtArtifactProvider["inspect"]>>;
  readonly provider: WabtArtifactProvider;
  readonly runtimePath: string;
  readonly cleanupAttempts: () => number;
  readonly cancellationReason: unknown;
}): Promise<void> => {
  if (options.mode === "cancelled-close") {
    expect(options.result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCancelledError",
        partialObservation: { normalized_result: { validation: "valid" } },
        cleanupIncomplete: false,
      },
    });
    if (!options.result.ok)
      expect(options.result.error.cause).toBe(options.cancellationReason);
    return;
  }
  expect(options.result).toMatchObject({
    ok: false,
    error: {
      _tag: "ProviderAdapterError",
      cleanupIncomplete: true,
      cleanupResources: [options.runtimePath],
      partialObservation: { normalized_result: { validation: "valid" } },
      diagnostics: { primary_error: { code: "cancelled" } },
    },
  });
  expect(options.cleanupAttempts()).toBe(1);
  if (!options.result.ok)
    expect(options.result.error.cleanupPrimary?.cause).toBe(
      options.cancellationReason,
    );
  await expect(access(options.runtimePath)).resolves.toBeUndefined();
  await options.provider.close();
  expect(options.cleanupAttempts()).toBe(2);
  expect(options.result).toMatchObject({
    error: { cleanupIncomplete: false, cleanupResources: [] },
  });
};

const createWabtArtifactFixture = async (bytes = Buffer.alloc(76, 1)) => {
  const selectedRoot = await createTestTempDirectory("rea-wabt-seam-");
  const path = join(selectedRoot, "selected.wasm");
  await writeFile(path, bytes);
  for (const tool of ["wasm-validate", "wasm-objdump", "wasm2wat"])
    await writeFile(
      join(selectedRoot, tool + (process.platform === "win32" ? ".exe" : "")),
      "source-owned executable seam",
      { mode: 0o700 },
    );
  const dump = await readFile(
    new URL("../../tests/fixtures/wasm/objdump.txt", import.meta.url),
    "utf8",
  );
  return { selectedRoot, path, bytes, dump };
};

it.each([
  { label: "muted", diagnostic: "", tool: "wasm2wat", valid: true },
  {
    label: "corroborated",
    diagnostic:
      "000000d: error: invalid utf-8 encoding: section name\nmodule.wasm: warning: opaque producer detail \t\n",
    tool: "wasm2wat",
    valid: true,
  },
  {
    label: "unmatched",
    diagnostic: "000000c: error: invalid utf-8 encoding: section name\n",
    tool: "wasm2wat",
    valid: false,
  },
  {
    label: "unrecognized",
    diagnostic: "000000d: error: another diagnostic\n",
    tool: "wasm-objdump",
    valid: false,
  },
])(
  "preserves $label diagnostics for a byte-corroborated blank name",
  async ({ diagnostic, tool, valid }) => {
    const bytes = Buffer.from(
      "0061736d01000000000a02fffe7061796c6f6164",
      "hex",
    );
    const fixture = await createWabtArtifactFixture(bytes);
    const dump =
      "\nmodule.wasm:\tfile format wasm 0x1\n\nSections:\n\n" +
      "   Custom start=0x0000000a end=0x00000014 (size=0x0000000a) \n" +
      "Section Details:\n";
    const wat = "(module)\n";
    const executed: string[] = [];
    const provider = new WabtArtifactProvider(
      { REA_WABT_BIN_DIRECTORY: fixture.selectedRoot },
      (input) => {
        const version = input.arguments[0] === "--version";
        const command = input.command.includes("wasm-objdump")
          ? "wasm-objdump"
          : input.command.includes("wasm2wat")
            ? "wasm2wat"
            : "wasm-validate";
        if (!version) executed.push(command);
        const stdout = version
          ? "1.0.42\n"
          : command === "wasm-objdump"
            ? dump
            : command === "wasm2wat"
              ? wat
              : "";
        const stderr = !version && command === tool ? diagnostic : "";
        return spawnOwnedProviderProcess({
          ...input,
          hostEnvironment: nodeHostEnvironment(input.hostEnvironment),
          command: process.execPath,
          arguments: [
            "-e",
            `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)});`,
          ],
        });
      },
    );
    try {
      const result = await provider.inspect({
        path: fixture.path,
        glue_paths: [],
        candidate_paths: [],
      });
      if (!valid) {
        expect(result).toMatchObject({
          ok: false,
          error: {
            _tag: "AnalysisOutputError",
            capturedOutput: {
              stdout: tool === "wasm-objdump" ? dump : wat,
              stderr: diagnostic,
            },
          },
        });
        expect(executed.at(-1)).toBe(tool);
        return;
      }
      if (!result.ok) throw result.error;
      expect(wasmArtifactSchema.parse(result.value.result)).toMatchObject({
        validation: "valid",
        debug_name_metadata: "unknown",
        sections: [{ kind: "Custom", start: 10, end: 20, description: "" }],
        custom_section_warnings:
          diagnostic === "" ? [] : [{ tool, text: diagnostic }],
        wat: { text: wat },
      });
    } finally {
      await provider.close();
    }
  },
);

it.each(["stdout", "stderr"] as const)(
  "rejects malformed UTF-8 in WABT %s while retaining literal replacement characters",
  async (stream) => {
    const fixture = await createWabtArtifactFixture();
    let malformed = true;
    const provider = new WabtArtifactProvider(
      { REA_WABT_BIN_DIRECTORY: fixture.selectedRoot },
      (input) => {
        const version = input.arguments[0] === "--version";
        const decoder = !version && input.command.includes("wasm2wat");
        const stdout = version
          ? "1.0.42\n"
          : input.command.includes("objdump")
            ? fixture.dump
            : decoder
              ? '(module (import "env" "literal\ufffd" (func)) (@custom "test" "payload"))\n'
              : "";
        const stderr = decoder ? "module.wasm: warning: literal\ufffd\n" : "";
        const output = { stdout, stderr };
        const bytes = Object.fromEntries(
          Object.entries(output).map(([name, text]) => {
            const encoded = Buffer.from(text);
            const replacement = encoded.indexOf(Buffer.from("\ufffd"));
            return [
              name,
              decoder && malformed && name === stream
                ? Buffer.concat([
                    encoded.subarray(0, replacement),
                    Buffer.from([0xff]),
                    encoded.subarray(replacement + 3),
                  ])
                : encoded,
            ];
          }),
        );
        return spawnOwnedProviderProcess({
          ...input,
          hostEnvironment: nodeHostEnvironment(input.hostEnvironment),
          command: process.execPath,
          arguments: [
            "-e",
            `process.stdout.write(Buffer.from(${JSON.stringify([...bytes.stdout!])})); process.stderr.write(Buffer.from(${JSON.stringify([...bytes.stderr!])}));`,
          ],
        });
      },
    );
    try {
      const input = { path: fixture.path, glue_paths: [], candidate_paths: [] };
      const rejected = await provider.inspect(input);
      expect(rejected).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisOutputError",
          diagnostics: { tool: "wasm2wat", invalid_utf8_streams: [stream] },
          capturedOutput: {
            [stream]: expect.stringContaining("\ufffd"),
            exit_code: 0,
            signal: null,
            truncated: false,
          },
          partialObservation: {
            normalized_result: {
              artifact: {
                path: fixture.path,
                sha256: createHash("sha256")
                  .update(fixture.bytes)
                  .digest("hex"),
                bytes: fixture.bytes.length,
              },
              validation: "valid",
            },
          },
        },
      });
      malformed = false;
      const corrected = await provider.inspect(input);
      if (!corrected.ok) throw corrected.error;
      expect(wasmArtifactSchema.parse(corrected.value.result)).toMatchObject({
        interface: { entries: [{ name: "literal\ufffd" }] },
        custom_section_warnings: [
          { tool: "wasm2wat", text: "module.wasm: warning: literal\ufffd\n" },
        ],
      });
    } finally {
      await provider.close();
    }
  },
);

it("preserves physical validation rejection when its diagnostics contain malformed UTF-8", async () => {
  const fixture = await createWabtArtifactFixture();
  const provider = new WabtArtifactProvider(
    { REA_WABT_BIN_DIRECTORY: fixture.selectedRoot },
    (input) => {
      const version = input.arguments[0] === "--version";
      return spawnOwnedProviderProcess({
        ...input,
        hostEnvironment: nodeHostEnvironment(input.hostEnvironment),
        command: process.execPath,
        arguments: [
          "-e",
          version
            ? 'process.stdout.write("1.0.42\\n")'
            : "process.stderr.write(Buffer.from([105,110,118,97,108,105,100,32,255])); process.exitCode = 7;",
        ],
      });
    },
  );
  try {
    const result = await provider.inspect({
      path: fixture.path,
      glue_paths: [],
      candidate_paths: [],
    });
    if (result.ok) throw new Error("Expected validation rejection");
    expect(result.error.capturedOutput).toEqual({
      stdout: "",
      stderr: "invalid \ufffd",
      stdout_bytes: 0,
      stderr_bytes: 9,
      exit_code: 7,
      signal: null,
      truncated: false,
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        partialObservation: {
          normalized_result: {
            artifact: {
              path: fixture.path,
              sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
              bytes: fixture.bytes.length,
            },
            validation: "rejected-by-selected-profile",
            exit_code: 7,
          },
        },
      },
    });
  } finally {
    await provider.close();
  }
});

it.each([
  "max_input_bytes",
  "max_tool_bytes",
  "max_output_bytes",
  "max_interface_bytes",
  "max_artifact_paths",
] as const)(
  "recovers the same complete artifact by changing only %s",
  async (parameter) => {
    const fixture = await createWabtArtifactFixture();
    const decodedWat = await readFile(
      new URL("../../tests/fixtures/wasm/decoded.wat", import.meta.url),
      "utf8",
    );
    const wat =
      parameter === "max_output_bytes" ? decodedWat.padEnd(2048) : decodedWat;
    // Admit the version probes and section inventory, then overflow in wasm2wat.
    const limitedBudget = parameter === "max_output_bytes" ? 1024 : 1;
    const provider = new WabtArtifactProvider(
      { REA_WABT_BIN_DIRECTORY: fixture.selectedRoot },
      (input) => {
        const output =
          input.arguments[0] === "--version"
            ? "1.0.42\n"
            : input.command.includes("objdump")
              ? fixture.dump
              : input.command.includes("wasm2wat")
                ? wat
                : "";
        return spawnOwnedProviderProcess({
          ...input,
          hostEnvironment: nodeHostEnvironment(input.hostEnvironment),
          command: process.execPath,
          arguments: ["-e", `process.stdout.write(${JSON.stringify(output)})`],
        });
      },
    );
    onTestFinished(() => provider.close());
    const service = new WasmArtifactService(provider);
    const candidatePaths: string[] = [];
    if (parameter === "max_artifact_paths") {
      for (let i = 0; i < 17; i++) {
        const candidate = join(
          fixture.selectedRoot,
          `candidate-${String(i)}.wasm`,
        );
        await writeFile(candidate, fixture.bytes);
        candidatePaths.push(candidate);
      }
    }
    const input = {
      path: fixture.path,
      glue_paths: [],
      candidate_paths: candidatePaths,
    };
    const rejected = await service.inspect({
      ...input,
      ...(parameter === "max_artifact_paths"
        ? {}
        : { [parameter]: limitedBudget }),
    });
    if (parameter === "max_interface_bytes") {
      if (!rejected.ok) throw rejected.error;
      expect(rejected.value.normalized_result).toMatchObject({
        interface: { state: "partial" },
      });
    } else {
      if (rejected.ok) throw new Error("Expected byte admission to fail");
      const projected = projectAnalysisError(rejected.error);
      if (parameter === "max_tool_bytes")
        expect(projected.code).toBe("capability_unavailable");
      expect(projected.remediation.action).toContain(parameter);
      if (parameter === "max_output_bytes") {
        expect(projected).toMatchObject({
          code: "resource_constraint",
          details: {
            captured_output: {
              stdout: wat.slice(0, limitedBudget),
              stderr: "",
              stderr_bytes: 0,
              truncated: true,
            },
          },
        });
        expect(rejected.error.capturedOutput?.stdout_bytes).toBeGreaterThan(
          limitedBudget,
        );
        expect(rejected.error.partialObservation).toMatchObject({
          normalized_result: {
            validation: "valid",
            artifact: {
              path: fixture.path,
              sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
              bytes: fixture.bytes.length,
            },
          },
        });
      }
    }
    const requestedBudget = parameter === "max_artifact_paths" ? 17 : 10_000;
    const recovered = await service.inspect({
      ...input,
      [parameter]: requestedBudget,
    });
    if (!recovered.ok) throw recovered.error;
    const report = wasmArtifactSchema.parse(recovered.value.normalized_result);
    expect(report.artifact.sha256).toBe(
      createHash("sha256").update(fixture.bytes).digest("hex"),
    );
    expect(report.wat.text).toBe(wat);
    expect(report.interface?.state).toBe("complete");
    expect(report.candidates).toHaveLength(candidatePaths.length + 1);
    expect(recovered.value.parameters[parameter]).toBe(requestedBudget);
    expect(report.tool_profile.output_budget_bytes).toBe(
      parameter === "max_output_bytes" ? 10_000 : 32 * 1024 * 1024,
    );
  },
);

it.each([
  {
    label: "a valid empty function-name map",
    preamble: "module name: <hello>\n",
    payload: String.raw`\00\06\05hello\01\01\00`,
    diagnostic: "",
    metadata: "complete",
  },
  {
    label: "a valid name with an unattributed custom-section warning",
    preamble: "module name: <hello>\n",
    payload: String.raw`\00\06\05hello\01\01\00`,
    diagnostic:
      "0000030: warning: unable to read u32 leb128: linking metadata version\n",
    metadata: "unknown",
  },
])(
  "keeps core WASM usable when optional name metadata is $label",
  async ({ preamble, payload, diagnostic, metadata }) => {
    const fixture = await createWabtArtifactFixture();
    const dump = [
      "",
      `module.wasm:\tfile format wasm 0x1\n${preamble}`.trimEnd(),
      "",
      "Sections:",
      "",
      ' Custom start=0x0000000a end=0x0000004c (size=0x00000042) "name"',
      "",
      "Section Details:",
      "",
    ].join("\n");
    const provider = new WabtArtifactProvider(
      { REA_WABT_BIN_DIRECTORY: fixture.selectedRoot },
      (input) => {
        const version = input.arguments[0] === "--version";
        const isObjdump = input.command.includes("wasm-objdump");
        const isDecoder = input.command.includes("wasm2wat");
        const stdout = version
          ? "1.0.42\n"
          : isObjdump
            ? dump
            : isDecoder
              ? `(module (@custom "name" "${payload}"))\n`
              : "";
        const stderr = version ? "" : diagnostic;
        return spawnOwnedProviderProcess({
          ...input,
          hostEnvironment: nodeHostEnvironment(input.hostEnvironment),
          command: process.execPath,
          arguments: [
            "-e",
            `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)});`,
          ],
        });
      },
    );
    try {
      const result = await provider.inspect({
        path: fixture.path,
        glue_paths: [],
        candidate_paths: [],
      });
      if (!result.ok) throw result.error;
      const report = wasmArtifactSchema.parse(result.value.result);
      expect(report).toMatchObject({
        validation: "valid",
        debug_name_metadata: metadata,
        custom_section_warnings:
          diagnostic === ""
            ? []
            : [
                { tool: "wasm-validate", text: diagnostic },
                { tool: "wasm-objdump", text: diagnostic },
                { tool: "wasm2wat", text: diagnostic },
              ],
        sections: [
          { kind: "Custom", start: 10, end: 76, description: '"name"' },
        ],
      });
      if (metadata !== "complete")
        expect(report.limitations).toContainEqual(
          expect.stringContaining(
            "complete debug-name coverage remains unknown",
          ),
        );
      else
        expect(report.limitations.join("\n")).not.toContain(
          "complete debug-name coverage remains unknown",
        );
      expect(report.artifact.sha256).toBe(
        createHash("sha256").update(fixture.bytes).digest("hex"),
      );
      expect(report.tool_profile.commands[0]?.arguments).toContain(
        "--ignore-custom-section-errors",
      );
      expect(Buffer.compare(await readFile(fixture.path), fixture.bytes)).toBe(
        0,
      );
      expect(report.headers).toBe(
        dump.slice(0, dump.indexOf("Section Details:\n")),
      );
      expect(report.wat.text).toBe(`(module (@custom "name" "${payload}"))\n`);
    } finally {
      await provider.close();
    }
  },
);

const assertModeOutcome = (
  mode: OutcomeMode,
  result: Awaited<ReturnType<WabtArtifactProvider["inspect"]>>,
  path: string,
): void => {
  if (mode.startsWith("invalid"))
    expect(result).toMatchObject({
      error: {
        partialObservation: {
          parameters: { command_timeout_ms: 42_000 },
          normalized_result: {
            tool_profile: {
              timeout_ms: 42_000,
              output_budget_bytes: WASM_RESOURCE_DEFAULTS.outputBytes,
            },
          },
        },
      },
    });
  if (mode === "success")
    expect(result).toMatchObject({
      ok: true,
      value: {
        result: {
          artifact: { path, bytes: 76 },
          validation: "valid",
          runtime_execution: "not-performed",
        },
      },
    });
  else
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag:
          process.platform === "win32" &&
          (mode === "snapshot-close-failure" ||
            mode === "snapshot-read-failure-late-abort")
            ? "ProviderAdapterError"
            : failureTags[mode],
      },
    });
  if (mode === "invalid-close")
    expect(result).toMatchObject({
      error: { capturedOutput: { stderr: "module.wasm: invalid bytes\n" } },
    });
  if (mode === "malformed")
    expect(result).toMatchObject({
      error: { capturedOutput: { stdout: "unexpected producer output" } },
    });
  if (mode === "malformed-wat" || mode === "wat-warning")
    expect(result).toMatchObject({
      error: {
        capturedOutput: {
          stdout:
            mode === "malformed-wat"
              ? "unexpected decoder output\n"
              : '(module (@custom "test" "payload"))\n',
          stderr: mode === "wat-warning" ? "decoder warning\n" : "",
        },
      },
    });
};

const assertFailedInspectionCleanupRecovery = async (
  provider: WabtArtifactProvider,
  result: Awaited<ReturnType<WabtArtifactProvider["inspect"]>>,
  cleanupAttempts: () => number,
  mode: OutcomeMode,
): Promise<void> => {
  expect(result).toMatchObject({ error: { cleanupIncomplete: true } });
  await provider.close();
  expect(cleanupAttempts()).toBe(2);
  if (result.ok) throw new Error("Expected inspection failure");
  expect(result.error.cleanupIncomplete).toBe(false);
  expect(projectAnalysisError(result.error)).toMatchObject({
    code:
      mode === "invalid-close-failure"
        ? "invalid_request"
        : "unreadable_output",
    details: {
      captured_output:
        mode === "invalid-close-failure"
          ? { stderr: "module.wasm: invalid bytes\n" }
          : { stdout: "unexpected producer output" },
      cleanup_history: expect.any(Object),
    },
  });
};

it.each([
  { selection: "relative", configured: "wabt/bin" },
  { selection: "absent", configured: undefined },
])(
  "refuses $selection WABT tool selection before workspace creation",
  async ({ configured }) => {
    const createRuntime = vi.fn(() => {
      throw new Error("Unavailable tools must not create a workspace");
    });
    const provider = new WabtArtifactProvider(
      configured === undefined ? {} : { REA_WABT_BIN_DIRECTORY: configured },
      undefined,
      createRuntime,
    );
    onTestFinished(() => provider.close());
    const result = await provider.inspect({
      path: "/module.wasm",
      glue_paths: [],
      candidate_paths: [],
    });
    if (result.ok) throw new Error("Expected tool directory refusal");
    expect(result.error).toMatchObject({
      _tag: "AnalysisCapabilityUnavailableError",
      reason: "directory_not_absolute",
      userMessage: "WABT configuration cannot be used",
    });
    expect(result.error.diagnostics).toEqual({
      code: "directory_not_absolute",
      setting: "REA_WABT_BIN_DIRECTORY",
      ...(configured === undefined ? {} : { configured }),
    });
    expect(projectAnalysisError(result.error).remediation.action).toContain(
      "REA_WABT_BIN_DIRECTORY",
    );
    expect(createRuntime).not.toHaveBeenCalled();
  },
);

it("preserves a pre-aborted caller reason without acquiring WASM facts", async () => {
  const reason = { source: "caller cancelled before provider admission" };
  const controller = new AbortController();
  controller.abort(reason);
  const createRuntime = vi.fn(() => {
    throw new Error("Pre-aborted inspection must not create a workspace");
  });
  const provider = new WabtArtifactProvider({}, undefined, createRuntime);
  try {
    const result = await provider.inspect(
      { path: "/not-read.wasm", glue_paths: [], candidate_paths: [] },
      { signal: controller.signal },
    );
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe(reason);
    expect(result.error.partialObservation).toBeUndefined();
    expect(createRuntime).not.toHaveBeenCalled();
  } finally {
    await provider.close();
  }
});

it.each([
  { tool: "wasm-validate", stdout: "1.0.41\n", stderr: "" },
  { tool: "wasm-objdump", stdout: "", stderr: "" },
  { tool: "wasm2wat", stdout: "1.0.42\n", stderr: "launcher warning\n" },
  {
    tool: "wasm-objdump",
    stdout: "",
    stderr: "version launcher failed\n",
    exitCode: 2,
  },
])(
  "retains the exact rejected $tool version probe and configuration recovery",
  async ({ tool, stdout, stderr, exitCode = 0 }) => {
    const root = await realpath(
      await createTestTempDirectory("rea-wabt-version-recovery-"),
    );
    const suffix = process.platform === "win32" ? ".exe" : "";
    for (const name of ["wasm-validate", "wasm-objdump", "wasm2wat"])
      await writeFile(join(root, name + suffix), "owned executable seam", {
        mode: 0o700,
      });
    const commands: string[] = [];
    const provider = new WabtArtifactProvider(
      { REA_WABT_BIN_DIRECTORY: root },
      (input) => {
        expect(input.arguments).toEqual(["--version"]);
        commands.push(input.command);
        const selected = input.command === join(root, tool + suffix);
        return spawnOwnedProviderProcess({
          ...input,
          hostEnvironment: nodeHostEnvironment(input.hostEnvironment),
          command: process.execPath,
          arguments: [
            "-e",
            `process.stdout.write(${JSON.stringify(selected ? stdout : "1.0.42\n")}); process.stderr.write(${JSON.stringify(selected ? stderr : "")}); process.exit(${String(selected ? exitCode : 0)});`,
          ],
        });
      },
    );
    try {
      const result = await provider.inspect({
        path: "/must-not-read-before-configuration.wasm",
        glue_paths: [],
        candidate_paths: [],
      });
      if (result.ok) throw new Error("Expected WABT configuration rejection");
      const projected = projectAnalysisError(result.error);
      expect(projected).toMatchObject({
        code: "capability_unavailable",
        retryable: false,
        details: {
          diagnostics: {
            configuration_key: "REA_WABT_BIN_DIRECTORY",
            executable_path: join(root, tool + suffix),
            tool,
            expected_version: "1.0.42",
          },
          captured_output: { stdout, stderr, truncated: false },
        },
      });
      expect(projected.remediation.action).toContain("--version");
      expect(projected.remediation.action).toContain("restart");
      expect(commands.at(-1)).toBe(join(root, tool + suffix));
    } finally {
      await provider.close();
    }
  },
);

it("reports a snapshot write the caller cancelled as that caller's cancellation", async () => {
  const root = await realpath(
    await createTestTempDirectory("rea-wabt-snapshot-cancel-"),
  );
  const suffix = process.platform === "win32" ? ".exe" : "";
  for (const name of ["wasm-validate", "wasm-objdump", "wasm2wat"])
    await writeFile(join(root, name + suffix), "owned executable seam", {
      mode: 0o700,
    });
  const modulePath = join(root, "selected.wasm");
  await writeFile(modulePath, Buffer.alloc(76, 1));
  const commands: string[][] = [];
  const provider = new WabtArtifactProvider(
    { REA_WABT_BIN_DIRECTORY: root },
    (input) => {
      commands.push([...input.arguments]);
      return spawnOwnedProviderProcess({
        ...input,
        hostEnvironment: nodeHostEnvironment(input.hostEnvironment),
        command: process.execPath,
        arguments: ["-e", 'process.stdout.write("1.0.42\\n");'],
      });
    },
  );
  const controller = new AbortController();
  fileCloseFailure.abortSnapshotWrite = controller;
  try {
    const result = await provider.inspect(
      { path: modulePath, glue_paths: [], candidate_paths: [] },
      { signal: controller.signal },
    );
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(controller.signal.aborted).toBe(true);
    expect(result.error.cause).toBe(controller.signal.reason);
    expect(commands).not.toHaveLength(0);
    for (const [command] of commands) expect(command).toBe("--version");
  } finally {
    fileCloseFailure.abortSnapshotWrite = undefined;
    await provider.close();
  }
});

it("admits a compatible caller WABT release and records the observed banner", async () => {
  const root = await realpath(
    await createTestTempDirectory("rea-wabt-compatible-release-"),
  );
  const suffix = process.platform === "win32" ? ".exe" : "";
  for (const name of ["wasm-validate", "wasm-objdump", "wasm2wat"])
    await writeFile(join(root, name + suffix), "owned executable seam", {
      mode: 0o700,
    });
  const modulePath = join(root, "selected.wasm");
  await writeFile(modulePath, Buffer.alloc(76, 1));
  const dump = await readFile(
    new URL("../../tests/fixtures/wasm/objdump.txt", import.meta.url),
    "utf8",
  );
  const provider = new WabtArtifactProvider(
    { REA_WABT_BIN_DIRECTORY: root },
    (input) => {
      const version = input.arguments[0] === "--version";
      const stdout = version
        ? "1.0.44\n"
        : input.command.includes("wasm-objdump")
          ? dump
          : input.command.includes("wasm2wat")
            ? '(module (@custom "test" "payload"))\n'
            : "";
      return spawnOwnedProviderProcess({
        ...input,
        hostEnvironment: nodeHostEnvironment(input.hostEnvironment),
        command: process.execPath,
        arguments: [
          "-e",
          `process.stdout.write(${JSON.stringify(stdout)}); process.exit(0);`,
        ],
      });
    },
  );
  try {
    const result = await provider.inspect({
      path: modulePath,
      glue_paths: [],
      candidate_paths: [],
    });
    if (!result.ok) throw result.error;
    const report = wasmArtifactSchema.parse(result.value.result);
    expect(report.tool_profile.release).toBe("1.0.44");
    expect(report.tool_profile.source_commit).toBeNull();
    expect(
      report.tool_profile.commands.map((command) =>
        command.version_banner.trim(),
      ),
    ).toEqual(["1.0.44", "1.0.44", "1.0.44"]);
    expect(report.limitations).toContainEqual(
      expect.stringContaining("uses caller-supplied WABT 1.0.44"),
    );
    expect(result.value.provider.version).toBe("wabt@1.0.44");
  } finally {
    await provider.close();
  }
});

it("keeps the compatible-release warning when validation rejects the input", async () => {
  const root = await realpath(
    await createTestTempDirectory("rea-wabt-compatible-rejection-"),
  );
  const suffix = process.platform === "win32" ? ".exe" : "";
  for (const name of ["wasm-validate", "wasm-objdump", "wasm2wat"])
    await writeFile(join(root, name + suffix), "owned executable seam", {
      mode: 0o700,
    });
  const modulePath = join(root, "rejected.wasm");
  await writeFile(modulePath, Buffer.alloc(76, 1));
  const provider = new WabtArtifactProvider(
    { REA_WABT_BIN_DIRECTORY: root },
    (input) => {
      const version = input.arguments[0] === "--version";
      const rejected = input.command.includes("wasm-validate");
      return spawnOwnedProviderProcess({
        ...input,
        hostEnvironment: nodeHostEnvironment(input.hostEnvironment),
        command: process.execPath,
        arguments: [
          "-e",
          `process.stderr.write(${JSON.stringify(rejected && !version ? "rejected" : "")}); process.stdout.write(${JSON.stringify(version ? "1.0.44\n" : "")}); process.exit(${rejected && !version ? 1 : 0});`,
        ],
      });
    },
  );
  try {
    const result = await provider.inspect({
      path: modulePath,
      glue_paths: [],
      candidate_paths: [],
    });
    if (result.ok) throw new Error("Expected validation rejection");
    expect(result.error.partialObservation).toMatchObject({
      normalized_result: { validation: "rejected-by-selected-profile" },
      limitations: expect.arrayContaining([
        expect.stringContaining("uses caller-supplied WABT 1.0.44"),
      ]),
    });
  } finally {
    await provider.close();
  }
});

it("rejects configured WABT tools whose admitted releases disagree", async () => {
  const root = await realpath(
    await createTestTempDirectory("rea-wabt-mixed-releases-"),
  );
  const suffix = process.platform === "win32" ? ".exe" : "";
  for (const name of ["wasm-validate", "wasm-objdump", "wasm2wat"])
    await writeFile(join(root, name + suffix), "owned executable seam", {
      mode: 0o700,
    });
  const provider = new WabtArtifactProvider(
    { REA_WABT_BIN_DIRECTORY: root },
    (input) =>
      spawnOwnedProviderProcess({
        ...input,
        hostEnvironment: nodeHostEnvironment(input.hostEnvironment),
        command: process.execPath,
        arguments: [
          "-e",
          `process.stdout.write(${JSON.stringify(
            input.command.includes("wasm-objdump") ? "1.0.44\n" : "1.0.42\n",
          )}); process.exit(0);`,
        ],
      }),
  );
  try {
    const result = await provider.inspect({
      path: "/must-not-read-before-configuration.wasm",
      glue_paths: [],
      candidate_paths: [],
    });
    if (result.ok) throw new Error("Expected mixed-release rejection");
    const projected = projectAnalysisError(result.error);
    expect(projected.code).toBe("capability_unavailable");
    expect(projected.message).toContain(
      "Configured WABT tools report different releases",
    );
    // The rejected banner keeps what the process wrote, not only its text.
    expect(result.error.capturedOutput).toEqual({
      stdout: "1.0.44\n",
      stderr: "",
      stdout_bytes: 7,
      stderr_bytes: 0,
      exit_code: 0,
      signal: null,
      truncated: false,
    });
  } finally {
    await provider.close();
  }
});

it("retries a retained input descriptor before admitting the next WABT operation", async () => {
  const root = await createTestTempDirectory("rea-wabt-read-cleanup-");
  const path = join(root, "selected.wasm");
  await writeFile(path, Buffer.alloc(76, 1));
  for (const tool of ["wasm-validate", "wasm-objdump", "wasm2wat"])
    await writeFile(
      join(root, tool + (process.platform === "win32" ? ".exe" : "")),
      "source-owned executable seam",
      { mode: 0o700 },
    );
  const dump = await readFile(
    new URL("../../tests/fixtures/wasm/objdump.txt", import.meta.url),
    "utf8",
  );
  const provider = new WabtArtifactProvider(
    { REA_WABT_BIN_DIRECTORY: root },
    async (input) => {
      const version = input.arguments[0] === "--version";
      const stdout = version
        ? "1.0.42\n"
        : input.command.includes("wasm-objdump")
          ? dump
          : input.command.includes("wasm2wat")
            ? '(module (@custom "test" "payload"))\n'
            : "";
      const launched = await spawnOwnedProviderProcess({
        ...input,
        hostEnvironment: nodeHostEnvironment(input.hostEnvironment),
        command: process.execPath,
        arguments: [
          "-e",
          `process.stdout.write(${JSON.stringify(stdout)}); process.exit(0);`,
        ],
      });
      return launched;
    },
  );
  fileCloseFailure.selectedPath = path;
  fileCloseFailure.attempts = 0;
  fileCloseFailure.failFirst = true;
  try {
    const first = await provider.inspect({
      path,
      candidate_paths: [],
      glue_paths: [],
    });
    expect(first).toMatchObject({
      ok: false,
      error: {
        cleanupIncomplete: true,
        cleanupResources: [path],
        cause: { message: "injected WABT input close failure" },
        partialObservation: {
          normalized_result: {
            artifact: {
              path,
              sha256: createHash("sha256")
                .update(Buffer.alloc(76, 1))
                .digest("hex"),
              bytes: 76,
            },
            candidates: [{ path }],
            glue: [],
            validation: "unknown",
            tool_profile: { release: "1.0.42" },
          },
        },
      },
    });
    expect(fileCloseFailure.attempts).toBe(1);

    const retried = await provider.inspect({
      path,
      candidate_paths: [],
      glue_paths: [],
    });
    expect(retried.ok).toBe(true);
    expect(fileCloseFailure.attempts).toBeGreaterThan(1);
    expect(first).toMatchObject({
      error: { cleanupIncomplete: false, cleanupResources: [] },
    });

    fileCloseFailure.failFirst = true;
    const closeRetry = await provider.inspect({
      path,
      candidate_paths: [],
      glue_paths: [],
    });
    expect(closeRetry).toMatchObject({
      ok: false,
      error: { cleanupIncomplete: true, cleanupResources: [path] },
    });
    const beforeClose = fileCloseFailure.attempts;
    await provider.close();
    expect(fileCloseFailure.attempts).toBeGreaterThan(beforeClose);
    expect(closeRetry).toMatchObject({
      error: { cleanupIncomplete: false, cleanupResources: [] },
    });
  } finally {
    fileCloseFailure.selectedPath = "";
    fileCloseFailure.failFirst = false;
    await provider.close();
  }
});

it("reports the first tool admission failure and tracks every sibling descriptor until release", async () => {
  const root = await realpath(
    await createTestTempDirectory("rea-wabt-tool-cleanup-"),
  );
  const suffix = process.platform === "win32" ? ".exe" : "";
  const siblingTools = ["wasm-objdump", "wasm2wat"].map((tool) =>
    join(root, tool + suffix),
  );
  for (const path of siblingTools) {
    await writeFile(path, "fixture tool", { mode: 0o755 });
    fileCloseFailure.toolCloseFailures.add(path);
  }
  const provider = new WabtArtifactProvider({ REA_WABT_BIN_DIRECTORY: root });
  try {
    const result = await provider.inspect({
      path: join(root, "selected.wasm"),
      candidate_paths: [],
      glue_paths: [],
    });
    if (result.ok) throw new Error("Expected rejected tool admission");
    const primary = projectAnalysisError(primaryAnalysisError(result.error));
    expect(primary.code).toBe("capability_unavailable");
    expect(primary.message).toContain("wasm-validate");
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.cleanupResources).toEqual(siblingTools);

    await provider.close();
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(result.error.cleanupResources).toEqual([]);
  } finally {
    fileCloseFailure.toolCloseFailures.clear();
    await provider.close();
  }
});

it.each([false, true])(
  "reports an unavailable private runtime root with retryable=%s without a misleading WABT remediation",
  async (retryable) => {
    const toolRoot = await createTestTempDirectory("rea-wabt-tool-root-");
    for (const tool of ["wasm-validate", "wasm-objdump", "wasm2wat"])
      await writeFile(
        join(toolRoot, tool + (process.platform === "win32" ? ".exe" : "")),
        "source-owned executable seam",
        { mode: 0o700 },
      );
    const provider = new WabtArtifactProvider(
      { REA_WABT_BIN_DIRECTORY: toolRoot },
      undefined,
      () => {
        throw new PrivateRuntimeRootUnavailableError(
          "REA Windows native controls are unavailable: probe failure",
          { retryable },
        );
      },
    );
    const result = await provider.inspect({
      path: "/module.wasm",
      glue_paths: [],
      candidate_paths: [],
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCapabilityUnavailableError",
        retryable,
        userMessage: undefined,
        message: expect.stringContaining(
          "REA Windows native controls are unavailable",
        ),
      },
    });
    if (result.ok)
      throw new Error("Unavailable runtime must refuse inspection");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "capability_unavailable",
      retryable,
      category: retryable ? "unavailable" : "unsupported_provider",
    });
  },
);
const assertGlueObservations = (
  value: unknown,
  inputs: readonly {
    readonly path: string;
    readonly source: string;
    readonly line: number;
    readonly column: number;
  }[],
  selectedPath: string,
): void => {
  const glue = wasmArtifactSchema.parse(value).glue;
  expect(glue).toHaveLength(inputs.length);
  for (const [index, { path, source, line, column }] of inputs.entries()) {
    expect(glue[index]).toMatchObject({
      artifact: {
        path,
        sha256: createHash("sha256").update(source).digest("hex"),
        bytes: Buffer.byteLength(source),
      },
      parse_status: "complete",
      references: [
        {
          value: "./selected.wasm",
          line,
          column,
          candidate_paths: [selectedPath],
          association: "local-path-candidate",
          evidence_kind: "static-literal",
        },
      ],
    });
  }
};

const launchWabtOutcome = async (
  input: Parameters<typeof spawnOwnedProviderProcess>[0],
  mode: OutcomeMode | "invalid",
  fixture: { bytes: Buffer; dump: string; controller: AbortController },
) => {
  const { bytes, dump, controller } = fixture;
  const version = input.arguments[0] === "--version";
  if (!version) {
    expect(
      Buffer.compare(
        await readFile(join(input.cwd ?? "", "module.wasm")),
        bytes,
      ),
    ).toBe(0);
    if (mode === "changed-snapshot") {
      const snapshot = join(input.cwd ?? "", "module.wasm");
      await chmod(snapshot, 0o600);
      await writeFile(snapshot, Buffer.alloc(76, 2));
    }
  }
  const stdout = version
    ? "1.0.42\n"
    : input.command.includes("objdump")
      ? mode === "malformed" || mode.startsWith("malformed-close")
        ? "unexpected producer output"
        : dump
      : input.command.includes("wasm2wat")
        ? mode === "malformed-wat"
          ? "unexpected decoder output\n"
          : '(module (@custom "test" "payload"))\n'
        : "";
  const invalid =
    !version &&
    (mode === "invalid" ||
      mode === "invalid-close" ||
      mode === "invalid-close-failure");
  const stderr = invalid
    ? "module.wasm: invalid bytes\n"
    : !version && input.command.includes("wasm2wat") && mode === "wat-warning"
      ? "decoder warning\n"
      : "";
  const script =
    !version && mode === "cancelled"
      ? "setInterval(() => undefined, 1000)"
      : `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exit(${invalid ? 1 : 0});`;
  const launched = await spawnOwnedProviderProcess({
    ...input,
    hostEnvironment: nodeHostEnvironment(input.hostEnvironment),
    command: process.execPath,
    arguments: ["-e", script],
  });
  if (!version && mode === "cancelled") {
    setImmediate(() => controller.abort());
  }
  return launched;
};

it("enforces a selected command deadline and completes a corrected retry after cleanup", async () => {
  const fixture = await createWabtArtifactFixture();
  let first = true;
  let runtimePath = "";
  const provider = new WabtArtifactProvider(
    { REA_WABT_BIN_DIRECTORY: fixture.selectedRoot },
    async (input) => {
      if (first) {
        first = false;
        return spawnOwnedProviderProcess({
          ...input,
          hostEnvironment: nodeHostEnvironment(input.hostEnvironment),
          command: process.execPath,
          arguments: ["-e", "setInterval(() => undefined, 1_000)"],
        });
      }
      return launchWabtOutcome(input, "success", {
        ...fixture,
        controller: new AbortController(),
      });
    },
    async () => {
      const root = await PrivateRuntimeRoot.create({
        prefix: "rea-wabt-budget-",
      });
      runtimePath = root.path;
      return root;
    },
  );
  onTestFinished(() => provider.close());
  const input = { path: fixture.path, glue_paths: [], candidate_paths: [] };
  const timed = await provider.inspect({ ...input, command_timeout_ms: 20 });
  if (timed.ok) throw new Error("Selected 20 ms deadline was not enforced");
  expect(projectAnalysisError(timed.error)).toMatchObject({
    code: "provider_timeout",
    details: {
      timeout_ms: 20,
      limit: {
        setting: "wasm.command_timeout_ms",
        effective_value: 20,
        source: "request",
        update_mode: "parameter",
      },
    },
    remediation: { action: expect.stringContaining("command_timeout_ms") },
  });
  expect(timed.error.cleanupIncomplete).toBe(false);
  await expect(access(runtimePath)).rejects.toMatchObject({ code: "ENOENT" });
  const corrected = await provider.inspect({
    ...input,
    command_timeout_ms: 2_000,
  });
  if (!corrected.ok) throw corrected.error;
  const report = wasmArtifactSchema.parse(corrected.value.result);
  expect(report.tool_profile.timeout_ms).toBe(2_000);
  expect(Buffer.compare(await readFile(fixture.path), fixture.bytes)).toBe(0);
});

const glueSourcesForOutcome = (mode: OutcomeMode) => {
  const literal = 'fetch("./selected.wasm");';
  return mode === "success"
    ? [
        { source: literal, line: 1, column: 6 },
        { source: `\uFEFF${literal}`, line: 1, column: 7 },
        { source: `\uFEFF\n${literal}`, line: 2, column: 6 },
        { source: `#!/usr/bin/env node\n${literal}`, line: 2, column: 6 },
        {
          source: `\uFEFF#!/usr/bin/env node\n${literal}`,
          line: 2,
          column: 6,
        },
        {
          source: String.raw`"./selected\u002ewasm";`,
          line: 1,
          column: 0,
        },
      ]
    : [];
};

const assertSnapshotCleanupOutcome = async (
  mode: OutcomeMode,
  result: Awaited<ReturnType<WabtArtifactProvider["inspect"]>>,
  provider: WabtArtifactProvider,
  runtimePath: string,
): Promise<void> => {
  if (
    mode !== "snapshot-close-failure" &&
    mode !== "snapshot-read-failure-late-abort"
  )
    return;
  try {
    expect(result).toMatchObject({
      error: {
        cleanupIncomplete: true,
        cleanupResources:
          process.platform === "win32"
            ? expect.arrayContaining([join(runtimePath, "module.wasm")])
            : [join(runtimePath, "module.wasm")],
      },
    });
  } finally {
    fileCloseFailure.failFirst = false;
    fileCloseFailure.failRead = undefined;
    await provider.close();
    fileCloseFailure.selectedPath = "";
  }
  expect(result).toMatchObject({
    error: { cleanupIncomplete: false, cleanupResources: [] },
  });
  if (!result.ok && mode === "snapshot-read-failure-late-abort") {
    if (process.platform === "win32")
      expect(result.error).toMatchObject({
        diagnostics: {
          primary_error: {
            details: {
              reason: expect.stringContaining("Authored snapshot read failure"),
            },
          },
        },
      });
    else
      expect(result.error).toMatchObject({
        _tag: "AnalysisOutputError",
        reason: expect.stringContaining("Authored snapshot read failure"),
      });
  }
};

const assertFailedInspectionCancellation = (
  mode: OutcomeMode,
  result: Awaited<ReturnType<WabtArtifactProvider["inspect"]>>,
  cancellationReason: unknown,
): void => {
  if (
    [
      "invalid-close",
      "invalid-close-failure",
      "malformed-close",
      "malformed-close-failure",
    ].includes(mode)
  ) {
    if (result.ok) throw new Error("Expected retained inspection failure");
    const primary = primaryAnalysisError(result.error);
    expect(primary.secondaryFailures).toHaveLength(1);
    expect(primary.secondaryFailures[0]).toBeInstanceOf(AnalysisCancelledError);
    expect(primary.secondaryFailures[0]?.cause).toBe(cancellationReason);
    expect(primary.partialObservation).toBeDefined();
    expect(primary.capturedOutput).toMatchObject(
      mode.startsWith("invalid")
        ? { stderr: "module.wasm: invalid bytes\n" }
        : { stdout: "unexpected producer output" },
    );
  }
};

const runOwnedArtifactOutcome = async (
  mode: OutcomeMode,
  cancellationReason: unknown = {
    source: "authored finalization cancellation",
  },
): Promise<void> => {
  const { selectedRoot, path, bytes, dump } = await createWabtArtifactFixture();
  let runtimePath = "";
  let runtimeCreations = 0;
  let acquiredPid: number | undefined;
  let cleanupAttempts = 0;
  const controller = new AbortController();
  const provider = new WabtArtifactProvider(
    { REA_WABT_BIN_DIRECTORY: selectedRoot },
    async (input) => {
      const launched = await launchWabtOutcome(input, mode, {
        bytes,
        dump,
        controller,
      });
      if (mode === "cancelled" && input.arguments[0] !== "--version")
        acquiredPid = launched.process.pid;
      return launched;
    },
    async () => {
      runtimeCreations += 1;
      const root = await PrivateRuntimeRoot.create({
        prefix: "rea-wabt-owned-test-",
      });
      runtimePath = root.path;
      if (
        mode === "snapshot-close-failure" ||
        mode === "snapshot-read-failure-late-abort"
      ) {
        fileCloseFailure.selectedPath = join(root.path, "module.wasm");
        fileCloseFailure.failFirst = true;
        fileCloseFailure.attempts = 0;
        if (mode === "snapshot-read-failure-late-abort")
          fileCloseFailure.failRead = () => {
            controller.abort("late abort after physical read failure");
            return Object.assign(new Error("Authored snapshot read failure"), {
              code: "EACCES",
            });
          };
      }
      return {
        path: root.path,
        close: async () => {
          if (mode === "cancelled-close-failure") {
            controller.abort(cancellationReason);
            if (++cleanupAttempts === 1)
              throw new Error("Source-owned cleanup uncertainty");
          }
          if (
            mode === "invalid-close-failure" ||
            mode === "malformed-close-failure"
          ) {
            controller.abort(cancellationReason);
            if (++cleanupAttempts === 1)
              throw new Error("Source-owned cleanup uncertainty");
          }
          if (mode === "cleanup" && ++cleanupAttempts <= 2)
            throw new Error("Source-owned cleanup uncertainty");
          await root.close();
          if (
            mode === "cancelled-close" ||
            mode === "invalid-close" ||
            mode === "malformed-close"
          )
            controller.abort(cancellationReason);
        },
      };
    },
  );
  const glueSources = glueSourcesForOutcome(mode);
  const glueInputs = glueSources.map(({ source, line, column }, index) => ({
    path: join(selectedRoot, `glue-${index}.js`),
    source,
    line,
    column,
  }));
  await Promise.all(
    glueInputs.map(({ path, source }) => writeFile(path, source)),
  );
  const result = await provider.inspect(
    {
      path,
      glue_paths: glueInputs.map(({ path }) => path),
      candidate_paths: [],
      ...(mode.startsWith("invalid") ? { command_timeout_ms: 42_000 } : {}),
    },
    { signal: controller.signal },
  );
  if (mode === "success" && result.ok)
    assertGlueObservations(result.value.result, glueInputs, path);
  assertModeOutcome(mode, result, path);
  if (mode === "cleanup") {
    await assertCleanupRecovery({
      provider,
      result,
      path,
      runtimePath,
      cleanupAttempts: () => cleanupAttempts,
      runtimeCreations: () => runtimeCreations,
    });
  }
  if (mode === "cancelled-close" || mode === "cancelled-close-failure")
    await assertCancellationDuringRootRelease({
      mode,
      result,
      provider,
      runtimePath,
      cleanupAttempts: () => cleanupAttempts,
      cancellationReason: controller.signal.reason,
    });
  if (mode === "invalid-close-failure" || mode === "malformed-close-failure")
    await assertFailedInspectionCleanupRecovery(
      provider,
      result,
      () => cleanupAttempts,
      mode,
    );
  assertFailedInspectionCancellation(mode, result, controller.signal.reason);
  await assertSnapshotCleanupOutcome(mode, result, provider, runtimePath);
  await expect(access(runtimePath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
  if (mode === "cancelled") {
    if (acquiredPid === undefined)
      throw new Error("The cancelled command did not report an acquired PID");
    const pid = acquiredPid;
    expect(() => process.kill(pid, 0)).toThrow();
  }
};

it.each(outcomeModes)(
  "owns private artifact bytes and retains %s outcome",
  (mode) => runOwnedArtifactOutcome(mode),
);

it.each([
  {
    stage: "validation rejection",
    mode: "invalid",
    validation: "rejected-by-selected-profile",
  },
  { stage: "candidate admission", mode: "success", validation: "unknown" },
  { stage: "candidate finalization", mode: "success", validation: "unknown" },
  { stage: "glue decoding", mode: "success", validation: "unknown" },
  { stage: "glue finalization", mode: "success", validation: "unknown" },
  { stage: "producer output", mode: "malformed-wat", validation: "valid" },
] as const)(
  "retains acquired file facts after $stage without claiming more module coverage",
  async ({ stage, mode, validation }) => {
    // Owned Node commands supply WABT-shaped responses; this checks provider
    // Evidence retention, not real WABT acceptance of the fixture bytes.
    const fixture = await createWabtArtifactFixture();
    const candidate = join(fixture.selectedRoot, "candidate.wasm");
    const gluePath = join(fixture.selectedRoot, "glue.js");
    const candidateFailure = stage.startsWith("candidate");
    const closingPath =
      stage === "candidate finalization"
        ? candidate
        : stage === "glue finalization"
          ? gluePath
          : undefined;
    const candidateBytes =
      stage === "candidate finalization"
        ? Buffer.alloc(1024 * 1024 + 29, 0xa5)
        : Buffer.from("independent candidate bytes");
    await writeFile(candidate, candidateBytes);
    const missing = join(fixture.selectedRoot, "missing.wasm");
    const glueSource = 'fetch("./selected.wasm");';
    const glueBytes =
      stage === "glue decoding" ? Buffer.from([0xff]) : Buffer.from(glueSource);
    await writeFile(gluePath, glueBytes);
    const provider = new WabtArtifactProvider(
      { REA_WABT_BIN_DIRECTORY: fixture.selectedRoot },
      (input) =>
        launchWabtOutcome(input, mode, {
          ...fixture,
          controller: new AbortController(),
        }),
    );
    if (closingPath !== undefined) {
      fileCloseFailure.selectedPath = closingPath;
      fileCloseFailure.attempts = 0;
      fileCloseFailure.failFirst = true;
    }
    try {
      const result = await provider.inspect(
        {
          path: fixture.path,
          candidate_paths:
            stage === "candidate admission"
              ? [fixture.path, candidate, candidate, missing, missing]
              : [candidate],
          glue_paths: candidateFailure ? [] : [gluePath],
        },
        { commandTimeoutMs: 42000 },
      );
      if (result.ok) throw new Error("Expected the selected failure stage");
      expect(result.error._tag).toBe(
        validation === "valid" ? "AnalysisOutputError" : "AnalysisInputError",
      );
      expect(result.error.partialObservation).toMatchObject({
        parameters: expect.not.objectContaining({
          command_timeout_ms: expect.anything(),
        }),
        normalized_result: {
          artifact: {
            path: fixture.path,
            sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
          },
          validation,
          tool_profile: { release: "1.0.42", timeout_ms: 42000 },
          candidates: [
            { path: fixture.path },
            {
              path: candidate,
              sha256: createHash("sha256").update(candidateBytes).digest("hex"),
              bytes: candidateBytes.length,
            },
          ],
          glue: candidateFailure
            ? []
            : [
                {
                  artifact: {
                    path: gluePath,
                    sha256: createHash("sha256")
                      .update(glueBytes)
                      .digest("hex"),
                  },
                  parse_status:
                    stage === "glue finalization"
                      ? "not-performed"
                      : stage === "glue decoding"
                        ? "failed"
                        : "complete",
                  references:
                    stage === "glue decoding" || stage === "glue finalization"
                      ? []
                      : [
                          {
                            value: "./selected.wasm",
                            candidate_paths: [fixture.path],
                          },
                        ],
                },
              ],
        },
      });
      if (validation === "rejected-by-selected-profile")
        expect(result.error.partialObservation).toMatchObject({
          normalized_result: {
            exit_code: 1,
            stderr: "module.wasm: invalid bytes\n",
          },
        });
      if (candidateFailure)
        expect(projectAnalysisError(result.error)).toMatchObject({
          code:
            stage === "candidate finalization"
              ? "cleanup_incomplete"
              : "invalid_request",
          details: {
            issues: [
              {
                path: [
                  "candidate_paths",
                  stage === "candidate finalization" ? 0 : 3,
                ],
              },
            ],
          },
        });
      else if (validation === "unknown")
        expect(result.error).toMatchObject({
          issues: [{ path: ["glue_paths", 0] }],
        });
      if (closingPath !== undefined) {
        expect(result.error).toMatchObject({
          cleanupIncomplete: true,
          cleanupResources: [closingPath],
        });
        expect(fileCloseFailure.attempts).toBe(1);
        await provider.close();
        expect(fileCloseFailure.attempts).toBe(2);
        expect(result.error.cleanupIncomplete).toBe(false);
      }
    } finally {
      await provider.close();
      fileCloseFailure.selectedPath = "";
      fileCloseFailure.failFirst = false;
    }
  },
);
it("preserves a null finalization abort reason through cleanup recovery", () =>
  runOwnedArtifactOutcome("cancelled-close-failure", null));
const outputLimitFailure = ({
  stdout = "(module",
  stderr = "",
  cleanupFailure = null,
}: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly cleanupFailure?: string | null;
} = {}) =>
  new OwnedCommandFailure(
    "output-limit",
    "Command diagnostic output exceeded its complete-output budget.",
    {
      diagnosticTruncated: true,
      // Observed sizes differ from retained sizes, as after a real overflow.
      stdout: {
        text: stdout,
        bytes: Buffer.byteLength(stdout),
        observedBytes: Buffer.byteLength(stdout) + 1000,
      },
      stderr: {
        text: stderr,
        bytes: Buffer.byteLength(stderr),
        observedBytes: Buffer.byteLength(stderr) + 1000,
      },
      exitCode: null,
      signal: "SIGKILL",
    },
    cleanupFailure,
    undefined,
    cleanupFailure === null ? [] : ["/owned/runtime"],
  );
it("reports WABT output overflow with bounded UTF-8 excerpts and observed byte counts", () => {
  const error = wabtFailure(
    outputLimitFailure({
      stdout: "a".repeat(4095) + "\u{1F600}b",
      stderr: "w".repeat(5000),
    }),
    "producer",
    "/module.wasm",
  );
  expect(error).toMatchObject({
    _tag: "AnalysisResourceConstraintError",
    resource: "memory",
    reportedLimits: { max_output_bytes: WASM_RESOURCE_DEFAULTS.outputBytes },
  });
  const projection = projectAnalysisError(error);
  expect(projection).toMatchObject({
    code: "resource_constraint",
    message: expect.stringContaining(
      `${String(WASM_RESOURCE_DEFAULTS.outputBytes)}-byte output budget`,
    ),
    remediation: {
      action: expect.stringContaining("max_output_bytes"),
    },
  });
  expect(projection.details?.captured_output).toEqual({
    stdout: "a".repeat(4095),
    stderr: "w".repeat(4096),
    truncated: true,
    stdout_bytes: 5100,
    stderr_bytes: 6000,
    exit_code: null,
    signal: "SIGKILL",
  });
});
it("does not attribute wasm-objdump output to a wasm2wat launch failure", async () => {
  const { selectedRoot, path, dump } = await createWabtArtifactFixture();
  const provider = new WabtArtifactProvider(
    { REA_WABT_BIN_DIRECTORY: selectedRoot },
    (input) => {
      const version = input.arguments[0] === "--version";
      if (!version && input.command.includes("wasm2wat"))
        throw spawnFailure("E2BIG", input.command);
      const script = version
        ? 'process.stdout.write("1.0.42\\n")'
        : input.command.includes("objdump")
          ? `process.stdout.write(${JSON.stringify(dump)})`
          : "";
      return spawnOwnedProviderProcess({
        ...input,
        hostEnvironment: nodeHostEnvironment(input.hostEnvironment),
        command: process.execPath,
        arguments: ["-e", script],
      });
    },
  );
  onTestFinished(() => provider.close());
  const result = await provider.inspect({
    path,
    glue_paths: [],
    candidate_paths: [],
  });
  if (result.ok) throw new Error("Expected the wasm2wat launch to fail");
  expect(result.error).toMatchObject({
    _tag: "AnalysisResourceConstraintError",
    resource: "transport",
    reportedLimits: { spawn_error: "E2BIG" },
  });
  expect(result.error.capturedOutput).toBeUndefined();
});

it("bounds the excerpt when cleanup also fails after the output budget", () => {
  expect(
    projectAnalysisError(
      wabtFailure(
        outputLimitFailure({
          stderr: "w".repeat(5000),
          cleanupFailure: "Source-owned cleanup uncertainty",
        }),
        "producer",
        "/module.wasm",
      ),
    ),
  ).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      // The typed output refusal stays the primary: its control is the
      // composite's limit, and its bounded excerpt is retained once.
      limit: {
        control_kind: "parameter",
        parameter: "max_output_bytes",
        effective_value: WASM_RESOURCE_DEFAULTS.outputBytes,
      },
      captured_output: {
        stdout: "(module",
        stderr: "w".repeat(4096),
        stdout_bytes: 1007,
        stderr_bytes: 6000,
        truncated: true,
      },
      diagnostics: {
        primary_error: {
          code: "resource_constraint",
          message: expect.stringContaining(
            `WABT output exceeded the ${String(WASM_RESOURCE_DEFAULTS.outputBytes)}-byte output budget`,
          ),
        },
      },
    },
  });
});
it("does not blame the input when a version probe exceeds the budget", () => {
  expect(
    wabtFailure(outputLimitFailure(), "configuration", "/module.wasm"),
  ).toMatchObject({
    _tag: "AnalysisResourceConstraintError",
    reportedLimits: { max_output_bytes: 32 * 1024 * 1024 },
  });
});
