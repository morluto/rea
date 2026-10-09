import { execFile } from "node:child_process";
import { constants as bufferConstants } from "node:buffer";
import {
  appendFile,
  chmod,
  open,
  symlink,
  type FileHandle,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, onTestFinished } from "vitest";

import { createCli } from "../../../src/cli.js";
import { isCliOperationFailure } from "../../../src/cliLogging.js";
import { parseCliJsonInput } from "../../../src/cliJsonInput.js";
import { analysisCliErrorEnvelopeSchema } from "../../../src/contracts/errorSchemas.js";
import { readWithoutFifoWriter } from "../../fixtures/fifoInput.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const runCli = async (arguments_: readonly string[]): Promise<unknown> => {
  let stdout = "";
  await createCli({}).serve([...arguments_, "--json"], {
    env: {},
    stdout: (chunk) => {
      stdout += chunk;
    },
    exit: () => undefined,
  });
  return JSON.parse(stdout) as unknown;
};

describe("CLI JSON file selection", () => {
  it("accepts a symlink to a regular JSON file", async () => {
    const root = await createTestTempDirectory("rea-json-input-symlink-");
    const path = join(root, "input.json");
    const selected = join(root, "selected.json");
    await writeFile(path, '{"value":1}');
    await symlink(path, selected, "file");
    expect(await parseCliJsonInput(selected, "test-input")).toEqual({
      ok: true,
      value: { value: 1 },
    });
  });

  it
    .skipIf(process.platform === "win32")
    .each(["a named pipe", "a symlink to a named pipe"])(
    "rejects %s without waiting for a writer",
    async (kind) => {
      const root = await createTestTempDirectory("rea-json-input-fifo-");
      const fifoPath = join(root, "input.pipe");
      await promisify(execFile)("mkfifo", [fifoPath]);
      const selected =
        kind === "a named pipe" ? fifoPath : join(root, "selected.json");
      if (selected !== fifoPath) await symlink(fifoPath, selected, "file");

      const outcome = await readWithoutFifoWriter(fifoPath, () =>
        parseCliJsonInput(selected, "test-input"),
      );
      expect(outcome.state).toBe("completed");
      if (outcome.state !== "completed")
        throw new Error("JSON read waited for a FIFO writer");
      expect(outcome.result).toMatchObject({
        ok: false,
        error: {
          code: "invalid_request",
          input_path: selected,
          input_reason: "read-failed",
          details: {
            issues: [
              {
                path: [],
                reason: "invalid_value",
                message: expect.stringContaining("(ENOTFILE)"),
              },
            ],
          },
        },
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a character device before parsing JSON bytes",
    async () => {
      expect(await parseCliJsonInput("/dev/null", "test-input")).toMatchObject({
        ok: false,
        error: {
          code: "invalid_request",
          input_path: "/dev/null",
          input_reason: "read-failed",
          details: {
            issues: [
              {
                path: [],
                reason: "invalid_value",
                message: expect.stringContaining("(ENOTFILE)"),
              },
            ],
          },
        },
      });
    },
  );
});

describe("CLI JSON input", () => {
  it("reports a valid file beyond the runtime string limit as too large", async () => {
    const root = await createTestTempDirectory("rea-json-input-too-large-");
    const path = join(root, "input.json");
    const size = bufferConstants.MAX_STRING_LENGTH + 1;
    await writeValidOversizedObject(path, size);

    const result = await parseCliJsonInput(path, "test-input");
    if (result.ok) throw new Error("Expected oversized JSON to be rejected");
    expect(analysisCliErrorEnvelopeSchema.parse(result.error)).toEqual(
      result.error,
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "resource_constraint",
        input_path: path,
        input_reason: "too-large",
        details: {
          resource: "memory",
          reported_limits: {
            boundary: "cli-json-input",
            max_string_code_units: bufferConstants.MAX_STRING_LENGTH,
          },
        },
        remediation: {
          action: expect.stringContaining("re-analyze a smaller selection"),
        },
      },
    });

    expect(isCliOperationFailure(result.error)).toBe(true);

    const characterCount =
      Math.floor(bufferConstants.MAX_STRING_LENGTH / 2) + 2;
    await writeValidMultibyteString(path, characterCount);

    const multibyteResult = await parseCliJsonInput(path, "test-input");
    if (!multibyteResult.ok)
      throw new Error("Expected large multibyte JSON to fit the string limit");
    if (typeof multibyteResult.value !== "string")
      throw new Error("Expected parsed JSON string");
    expect(multibyteResult.value.length).toBe(characterCount);

    // Large-input streaming must flush and reject an incomplete UTF-8 suffix.
    await appendFile(path, Buffer.from([0xc3]));
    expect(await parseCliJsonInput(path, "test-input")).toMatchObject({
      ok: false,
      error: { input_path: path, input_reason: "invalid-json" },
    });
  }, 20_000);

  it("distinguishes malformed inline text from files and preserves bracket-prefixed paths", async () => {
    expect(await parseCliJsonInput("[", "test-input")).toMatchObject({
      ok: false,
      error: {
        details: { issues: [{ reason: "invalid_format", expected: "JSON" }] },
      },
    });
    const root = await createTestTempDirectory("rea-json-input-");
    const path = join(root, "input.json");
    await writeFile(path, '{"value":1}');
    expect(await parseCliJsonInput(path, "test-input")).toEqual({
      ok: true,
      value: { value: 1 },
    });
    expect(await parseCliJsonInput("false", "test-input")).toEqual({
      ok: true,
      value: false,
    });
    const bracketPath = join(root, "[input].json");
    await writeFile(bracketPath, '["preserved"]');
    expect(await parseCliJsonInput(bracketPath, "test-input")).toEqual({
      ok: true,
      value: ["preserved"],
    });
    for (const missingPath of [
      join(root, "{capture}.json"),
      join(root, "[missing].json"),
    ])
      expect(await parseCliJsonInput(missingPath, "test-input")).toMatchObject({
        ok: false,
        error: { input_path: missingPath, input_reason: "read-failed" },
      });
    expect(await parseCliJsonInput(root, "test-input")).toMatchObject({
      ok: false,
      error: { input_reason: "read-failed" },
    });
  });

  it.each([
    ["a missing file", "ENOENT"],
    ["a directory", "EISDIR"],
  ] as const)(
    "lists the system cause when %s cannot be read",
    async (kind, code) => {
      const root = await createTestTempDirectory("rea-json-input-cause-");
      const path = kind === "a directory" ? root : join(root, "missing.json");
      expect(await parseCliJsonInput(path, "test-input")).toMatchObject({
        ok: false,
        error: {
          code: "invalid_request",
          input_path: path,
          input_reason: "read-failed",
          details: {
            issues: [
              {
                path: [],
                reason: "invalid_value",
                message: `The JSON input file could not be read (${code}): ${path}`,
              },
            ],
          },
        },
      });
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "projects a real permission denial as access_denied",
    async () => {
      const root = await createTestTempDirectory("rea-json-input-denied-");
      const path = join(root, "input.json");
      await writeFile(path, "{}");
      await chmod(path, 0o000);
      onTestFinished(() => chmod(path, 0o600));
      const result = await runCli(["inspect-analysis-view", path]);
      expect(analysisCliErrorEnvelopeSchema.parse(result)).toMatchObject({
        error: "Application workflow failed",
        code: "access_denied",
        category: "unavailable",
        details: {
          operation: "inspect-analysis-view",
          path,
          system_code: "EACCES",
          boundary: "filesystem-read",
        },
        input_path: path,
        input_reason: "read-failed",
        remediation: { action: expect.stringContaining("read access") },
      });
    },
  );
});

const writeRepeatedBytes = async (
  handle: FileHandle,
  bytes: Buffer,
  length: number,
): Promise<void> => {
  let remaining = length;
  while (remaining > 0) {
    const chunkLength = Math.min(bytes.length, remaining);
    await handle.writeFile(bytes.subarray(0, chunkLength));
    remaining -= chunkLength;
  }
};

const writeValidOversizedObject = async (
  path: string,
  size: number,
): Promise<void> => {
  const handle = await open(path, "w");
  const whitespace = Buffer.alloc(1024 * 1024, 0x20);
  try {
    await handle.writeFile("{");
    await writeRepeatedBytes(handle, whitespace, size - 2);
    await handle.writeFile("}");
  } finally {
    await handle.close();
  }
};

const writeValidMultibyteString = async (
  path: string,
  characterCount: number,
): Promise<void> => {
  const encodedCharacters = Buffer.from("é".repeat(512 * 1024));
  const byteLength = characterCount * 2 + 2;
  const handle = await open(path, "w");
  try {
    await handle.writeFile('"');
    await writeRepeatedBytes(handle, encodedCharacters, byteLength - 2);
    await handle.writeFile('"');
  } finally {
    await handle.close();
  }
};
