import { execFile } from "node:child_process";
import { chmod, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, onTestFinished } from "vitest";

import { createCli } from "../../../src/cli.js";
import { parseCliJsonInput } from "../../../src/cliJsonInput.js";
import { readCliJsonFile } from "../../../src/cliJsonFile.js";
import { analysisCliErrorEnvelopeSchema } from "../../../src/contracts/errorSchemas.js";
import { JSON_BYTE_ORDER_MARK_MESSAGE } from "../../../src/application/Utf8JsonInput.js";
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

describe("CLI JSON streamed input", () => {
  it("preserves native JSON meanings through chunked file parsing", async () => {
    const root = await createTestTempDirectory("rea-json-input-chunks-");
    const path = join(root, "input.json");
    const documents = [
      "null",
      "false",
      "-0",
      "1e400",
      '{"__proto__":{"observed":true},"constructor":2,"duplicate":1,"duplicate":3}',
      JSON.stringify({
        text: `${"x".repeat(65_524)}😀漢字`,
        escaped: "\ud800",
      }),
      JSON.stringify({ [`${"x".repeat(70_000)}😀`]: "long key" }),
      JSON.stringify(
        Array.from({ length: 4_000 }, (_, id) => ({ id, text: "å" })),
      ),
    ];
    for (const text of documents) {
      await writeFile(path, `${" ".repeat(9 * 1024 * 1024)}${text}`);
      const parsed = await parseCliJsonInput(path, "test-input");
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
      expect(parsed.value).toEqual(JSON.parse(text));
      if (text.includes("__proto__")) {
        if (typeof parsed.value !== "object" || parsed.value === null)
          throw new Error("Expected the parsed object");
        expect(Object.getPrototypeOf(parsed.value)).toBe(Object.prototype);
        expect(Object.hasOwn(parsed.value, "__proto__")).toBe(true);
      }
    }
  });

  it.each([
    "",
    "[1,]",
    "{} {}",
    '{"value":',
    '"unterminated',
    "\uFEFF{}",
    "\u00a0{}",
    "{\u000b}",
    "01",
    "NaN",
    '"\u0001"',
  ])("rejects strict JSON syntax violations in files (%j)", async (text) => {
    const root = await createTestTempDirectory("rea-json-input-invalid-");
    const path = join(root, "input.json");
    for (const prefix of ["", " ".repeat(9 * 1024 * 1024)]) {
      await writeFile(path, `${prefix}${text}`);
      expect(await parseCliJsonInput(path, "test-input")).toMatchObject({
        ok: false,
        error: {
          code: "invalid_request",
          input_path: path,
          input_reason: "invalid-json",
        },
      });
    }
  });

  it("names a leading byte-order mark in small and streamed files", async () => {
    const root = await createTestTempDirectory("rea-json-input-bom-");
    const path = join(root, "input.json");
    for (const body of ["{}", `${" ".repeat(9 * 1024 * 1024)}{}`]) {
      await writeFile(path, `\uFEFF${body}`);
      expect(await parseCliJsonInput(path, "test-input")).toMatchObject({
        ok: false,
        error: {
          input_reason: "invalid-json",
          details: { issues: [{ message: JSON_BYTE_ORDER_MARK_MESSAGE }] },
        },
      });
    }
  });

  it.each([Buffer.from([0xf0, 0x28, 0x8c, 0xbc]), Buffer.from([0xe2, 0x82])])(
    "rejects malformed and incomplete UTF-8 at a read boundary (%j)",
    async (invalid) => {
      const root = await createTestTempDirectory("rea-json-input-utf8-");
      const path = join(root, "input.json");
      await writeFile(
        path,
        Buffer.concat([
          Buffer.from(`${" ".repeat(9 * 1024 * 1024)}"${"x".repeat(65_534)}`),
          invalid,
        ]),
      );
      expect(await parseCliJsonInput(path, "test-input")).toMatchObject({
        ok: false,
        error: {
          input_reason: "invalid-json",
          details: { issues: [{ message: "JSON input is not valid UTF-8" }] },
        },
      });
    },
  );

  it("cancels a file parse and allows a following read", async () => {
    const root = await createTestTempDirectory("rea-json-input-cancel-");
    const path = join(root, "input.json");
    await writeFile(path, `${" ".repeat(9 * 1024 * 1024)}{"after":true}`);
    const controller = new AbortController();
    const cancelled = readCliJsonFile(path, "test-input", controller.signal);
    setImmediate(() => controller.abort(new Error("cancel JSON file parse")));
    await expect(cancelled).rejects.toThrow("cancel JSON file parse");
    await writeFile(path, '{"after":true}');
    expect(await readCliJsonFile(path, "test-input")).toEqual({
      ok: true,
      value: { after: true },
    });
  });
});

describe("CLI JSON input", () => {
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
