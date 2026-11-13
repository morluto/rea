import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it as test, onTestFinished } from "vitest";

import type { BinaryTarget } from "../../../../src/domain/binaryTargetTypes.js";
import { KunaProvider } from "../../../../src/kuna/KunaProvider.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { writeFakeKuna } from "./fakeKuna.js";
import { withKunaResourceScope } from "./kunaResourceScope.js";

const it = test.skipIf(process.platform === "win32");
const MARKER = "KUNA_OUTPUT_MARKER";

/** Emit selected actual bytes before the fixture executable is fingerprinted. */
const fixture = async (
  mode:
    | "invalid"
    | "invalid-long"
    | "unicode"
    | "unicode-exit"
    | "stderr"
    | "exit",
  subcommand?: string,
) => {
  const root = await createTestTempDirectory("rea-kuna-buffered-output-");
  const kuna = await writeFakeKuna(root, {
    functions: [{ name: MARKER, addr: "0x1000" }],
    ...(mode === "invalid-long" ? { decompilePadding: 5000 } : {}),
  });
  const script = await readFile(kuna, "utf8");
  const newline = script.indexOf("\n") + 1;
  const replacement =
    mode === "invalid" || mode === "invalid-long" || mode === "exit"
      ? [0xff]
      : [...Buffer.from("�Δ")];
  const output = `
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  ${mode === "unicode-exit" ? 'if (process.argv[2] === "xrefs") return originalWrite("😀".repeat(3000) + "x", ...rest);' : ""}
  const bytes = Buffer.from(chunk);
  const marker = Buffer.from(process.argv[2] === "xrefs" ? "fixture reference" : ${JSON.stringify(MARKER)});
  const index = ${subcommand === undefined ? "true" : `process.argv[2] === ${JSON.stringify(subcommand)}`} ? bytes.indexOf(marker) : -1;
  const replaced = index < 0 ? bytes : Buffer.concat([bytes.subarray(0, index), Buffer.from(${JSON.stringify(replacement)}), bytes.subarray(index + marker.length)]);
  return originalWrite(replaced, ...rest);
};
${mode === "stderr" ? 'if (process.argv[2] !== "--version") process.stderr.write(Buffer.from([0xff]));' : ""}
${mode === "exit" || mode === "unicode-exit" ? 'if (process.argv[2] === "xrefs") { process.exitCode = 7; process.stderr.write("physical failure"); }' : ""}
${mode === "invalid" || mode === "invalid-long" ? `if (process.argv[2] === ${JSON.stringify(subcommand)}) process.stderr.write("fixture diagnostic");` : ""}
`;
  await writeFile(
    kuna,
    script.slice(0, newline) + output + script.slice(newline),
  );
  const path = join(root, "program");
  await writeFile(path, "program");
  const target: BinaryTarget = {
    path,
    sha256: createHash("sha256").update("program").digest("hex"),
    kind: "executable",
    format: "elf",
    architecture: "x86_64",
    availableArchitectures: ["x86_64"],
  };
  const provider = new KunaProvider({
    REA_KUNA_COMMAND: kuna,
    REA_KUNA_CACHE_DIR: join(root, "cache"),
  });
  onTestFinished(async () => {
    const closed = await provider.closeOwnedResources();
    if (!closed.ok) throw closed.error;
  });
  const profile = await withKunaResourceScope((resourceScope) =>
    provider.resolveAnalysisProfile(target, { resourceScope }),
  );
  if (!profile.ok || profile.value.profile === null)
    throw new Error("Fixture profile did not resolve");
  const client = provider.createClient(target, profile.value.profile);
  onTestFinished(async () => {
    const closed = await client.close();
    if (!closed.ok) throw closed.error;
  });
  return client;
};

it.each(["list_procedures", "procedure_pseudo_code", "xrefs"] as const)(
  "rejects invalid buffered UTF-8 before answering %s",
  async (operation) => {
    const client = await fixture(
      "invalid",
      operation === "list_procedures"
        ? "functions"
        : operation === "procedure_pseudo_code"
          ? "decompile"
          : "xrefs",
    );
    const result = await client.execute(
      operation,
      operation === "xrefs"
        ? { address: "0x1000" }
        : operation === "procedure_pseudo_code"
          ? { procedure: "0x1000", analysis: "independent_fresh" }
          : {},
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisOutputError",
        diagnostics: { stdout_invalid_utf8: true },
        capturedOutput: {
          stdout: expect.stringContaining("�"),
          stderr: "fixture diagnostic",
          stderr_bytes: Buffer.byteLength("fixture diagnostic"),
          exit_code: 0,
          signal: null,
          truncated: false,
        },
      },
    });
    if (result.ok) throw new Error("Expected malformed provider output");
    const output = result.error.capturedOutput;
    if (output === undefined) throw new Error("Expected captured diagnostics");
    // The emitted 0xff occupies one byte; its display replacement occupies three.
    expect(output.stdout_bytes).toBe(Buffer.byteLength(output.stdout) - 2);
  },
);

it("preserves a physical command failure and its malformed output diagnostics", async () => {
  const client = await fixture("exit", "xrefs");
  expect(await client.execute("xrefs", { address: "0x1000" })).toMatchObject({
    ok: false,
    error: {
      _tag: "ProviderAdapterError",
      capturedOutput: {
        stdout: expect.stringContaining("�"),
        stderr: "physical failure",
        stdout_bytes: expect.any(Number),
        stderr_bytes: Buffer.byteLength("physical failure"),
        exit_code: 7,
        signal: null,
        truncated: false,
      },
    },
  });
});

it("marks the bounded diagnostic tail without losing the observed byte count", async () => {
  const client = await fixture("invalid-long", "decompile");
  const result = await client.execute("procedure_pseudo_code", {
    procedure: "0x1000",
    analysis: "independent_fresh",
  });
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisOutputError",
      diagnostics: { stdout_invalid_utf8: true },
      capturedOutput: {
        stderr: "fixture diagnostic",
        stderr_bytes: Buffer.byteLength("fixture diagnostic"),
        truncated: true,
        exit_code: 0,
        signal: null,
      },
    },
  });
  if (result.ok) throw new Error("Expected malformed provider output");
  expect(result.error.capturedOutput?.stdout).toHaveLength(4096);
  expect(result.error.capturedOutput?.stdout_bytes).toBeGreaterThan(5000);
});

it("keeps a valid Unicode diagnostic tail intact through a physical failure", async () => {
  const client = await fixture("unicode-exit", "xrefs");
  const result = await client.execute("xrefs", { address: "0x1000" });
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "ProviderAdapterError",
      capturedOutput: {
        stdout_bytes: 12001,
        stderr: "physical failure",
        exit_code: 7,
        signal: null,
        truncated: true,
      },
    },
  });
  if (result.ok) throw new Error("Expected physical command failure");
  const output = result.error.capturedOutput;
  if (output === undefined) throw new Error("Expected captured diagnostics");
  // Encoding the decoded diagnostic must preserve every character.
  expect(Buffer.from(output.stdout).toString("utf8")).toBe(output.stdout);
  expect(output.stdout.length).toBeLessThanOrEqual(4096);
  expect(output.stdout).toBe("😀".repeat(2047) + "x");
});

it.each(["unicode", "stderr"] as const)(
  "preserves valid source text with %s output",
  async (mode) => {
    const client = await fixture(mode);
    const listed = await client.execute("list_procedures", {});
    expect(listed).toMatchObject({
      ok: true,
      value: {
        result: [{ address: "0x1000", value: "�Δ" }, expect.anything()],
      },
    });
    const text = await client.execute("procedure_pseudo_code", {
      procedure: "0x1000",
      analysis: "independent_fresh",
    });
    expect(text).toMatchObject({
      ok: true,
      value: { result: expect.stringContaining("int �Δ(void)") },
    });
    expect(await client.execute("xrefs", { address: "0x1000" })).toMatchObject({
      ok: true,
      value: { result: ["0x1004"] },
    });
  },
);
