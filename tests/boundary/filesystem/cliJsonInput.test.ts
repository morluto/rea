import { getEventListeners } from "node:events";
import { execFile } from "node:child_process";
import {
  chmod,
  open,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { closeCliResources, createCli } from "../../../src/cli.js";
import { parseCliJsonInput } from "../../../src/cli/cliJsonInput.js";
import { cliJavaScriptSourcePaths } from "../../../src/cli/javascriptApplicationAnalysis.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
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
    await writeFile(path, '{"value":"valid �, é, and 😀"}');
    await symlink(path, selected, "file");
    expect(await parseCliJsonInput(selected, "test-input")).toEqual({
      ok: true,
      value: { value: "valid �, é, and 😀" },
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
        text: `${"x".repeat(65_524)}😀漢字�`,
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

  const invalidFile = (path: string) => ({
    ok: false,
    error: {
      code: "invalid_request",
      input_path: path,
      input_reason: "invalid-json",
    },
  });

  it.each([
    "",
    "[1,]",
    "{} {}",
    '{"value":',
    '"unterminated',
    "\u00a0{}",
    "{\u000b}",
    "01",
    "NaN",
    '"\u0001"',
  ])("rejects streamed JSON syntax violations (%j)", async (text) => {
    const root = await createTestTempDirectory("rea-json-input-invalid-");
    const path = join(root, "input.json");
    await writeFile(path, `${" ".repeat(9 * 1024 * 1024)}${text}`);
    expect(await parseCliJsonInput(path, "test-input")).toMatchObject(
      invalidFile(path),
    );
  });

  it("keeps malformed source excerpts out of native and streamed file diagnostics", async () => {
    const root = await createTestTempDirectory("rea-json-input-excerpt-");
    const path = join(root, "input.json");
    for (const prefix of ["", " ".repeat(9 * 1024 * 1024)]) {
      await writeFile(path, `${prefix}{"$ref":"https://u:p@h","":NaN}`);
      const result = await parseCliJsonInput(path, "test-input");
      expect(result).toMatchObject(invalidFile(path));
      expect(JSON.stringify(result)).not.toContain("u:p@h");
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
          details: {
            issues: [
              {
                message: expect.stringMatching(
                  /byte-order mark.*UTF-8 without a byte-order mark/iu,
                ),
              },
            ],
          },
        },
      });
    }
  });

  it.each([
    {
      name: "malformed bytes within a string",
      invalid: Buffer.from([0xf0, 0x28, 0x8c, 0xbc, 0x22]),
    },
    {
      name: "an incomplete character at EOF",
      invalid: Buffer.from([0xe2, 0x82]),
    },
  ])("rejects $name in small and streamed files", async ({ invalid }) => {
    const root = await createTestTempDirectory("rea-json-input-utf8-");
    const path = join(root, "input.json");
    for (const prefix of [
      '"',
      `${" ".repeat(9 * 1024 * 1024)}"${"x".repeat(65_534)}`,
    ]) {
      await writeFile(path, Buffer.concat([Buffer.from(prefix), invalid]));
      expect(await parseCliJsonInput(path, "test-input")).toMatchObject({
        ok: false,
        error: {
          input_reason: "invalid-json",
          details: { issues: [{ message: "JSON input is not valid UTF-8" }] },
        },
      });
    }
  });
});

describe("CLI JSON input", () => {
  it("accepts a falsy inline JSON document", async () => {
    expect(await parseCliJsonInput("false", "test-input")).toEqual({
      ok: true,
      value: false,
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
          operation: "inspect_analysis_view",
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

describe("CLI JSON file cancellation", () => {
  const writeSelection = async (): Promise<string> => {
    const root = await createTestTempDirectory("rea-json-input-cancel-");
    const path = join(root, "paths.json");
    await writeFile(path, JSON.stringify(["main.js", "package.json"]));
    return path;
  };

  it("reports cancellation through --source-paths-json selection", async () => {
    const path = await writeSelection();
    const controller = new AbortController();
    controller.abort();
    expect(
      await cliJavaScriptSourcePaths(["index.js"], path, controller.signal),
    ).toMatchObject({ ok: false, error: { code: "cancelled" } });
  });

  it("still reads the selection when the signal is not aborted", async () => {
    const path = await writeSelection();
    expect(
      await cliJavaScriptSourcePaths(
        ["index.js"],
        path,
        new AbortController().signal,
      ),
    ).toEqual({ ok: true, value: ["index.js", "main.js", "package.json"] });
  });
});

describe("CLI JSON standard input", () => {
  it("rejects empty stdin with invalid-json", async () => {
    const stream = Readable.from([]);
    const result = await parseCliJsonInput("-", "test-input", undefined, {
      stdin: stream,
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_request",
        input_path: "-",
        input_reason: "invalid-json",
        details: {
          issues: [{ path: [], reason: "invalid_format" }],
        },
      },
    });
  });

  it("rejects oversized stdin with too-large", async () => {
    const stream = Readable.from([Buffer.alloc(8 * 1024 * 1024 + 1, 0x78)]);
    const result = await parseCliJsonInput("-", "test-input", undefined, {
      stdin: stream,
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "resource_constraint",
        input_path: "-",
        input_reason: "too-large",
        details: {
          resource: "memory",
        },
      },
    });
  });
});

describe("CLI JSON stdin cancellation and encoding", () => {
  it.each([false, true])(
    "interrupts an idle stdin read (partial input: %s)",
    async (partial) => {
      const controller = new AbortController();
      let started!: () => void;
      const reading = new Promise<void>((resolve) => {
        started = resolve;
      });
      const stream = new Readable({
        read() {
          started();
        },
      });
      onTestFinished(() => {
        stream.destroy();
      });
      if (partial) stream.push('{"partial":');
      const pending = parseCliJsonInput("-", "test-input", controller.signal, {
        stdin: stream,
      });
      await reading;
      // Let any initial chunk be consumed before aborting the next idle read.
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort("stop idle stdin");
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: "cancelled" },
      });
      expect(stream.destroyed).toBe(true);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    },
  );

  it("reads UTF-8 split between chunks and accepts the exact byte limit", async () => {
    const prefix = Buffer.from('{"label":"');
    const suffix = Buffer.from('中文🦀�"}');
    const padding = Buffer.alloc(
      8 * 1024 * 1024 - prefix.length - suffix.length,
      0x61,
    );
    const result = await parseCliJsonInput("-", "test-input", undefined, {
      stdin: Readable.from([
        prefix,
        padding,
        ...[...suffix].map((byte) => Buffer.from([byte])),
      ]),
    });
    expect(result).toEqual({
      ok: true,
      value: { label: `${"a".repeat(padding.length)}中文🦀�` },
    });
  });

  it("projects cancellation during stdin snapshot sealing", async () => {
    const controller = new AbortController();
    const stream = Readable.from([
      JSON.stringify(Array.from({ length: 20_000 }, (_, index) => ({ index }))),
    ]);
    stream.once("end", () =>
      setImmediate(() => controller.abort("stop sealing")),
    );
    await expect(
      parseCliJsonInput("-", "test-input", controller.signal, {
        stdin: stream,
        snapshot: true,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("seals stdin snapshots and releases the abort listener on success", async () => {
    const controller = new AbortController();
    const result = await parseCliJsonInput(
      "-",
      "test-input",
      controller.signal,
      {
        stdin: Readable.from(['{"nested":{"value":1}}']),
        snapshot: true,
      },
    );
    expect(result).toEqual({ ok: true, value: { nested: { value: 1 } } });
    if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("preserves stdin physical failure and releases the abort listener", async () => {
    const controller = new AbortController();
    const stream = new Readable({
      read() {
        this.destroy(Object.assign(new Error("read failed"), { code: "EIO" }));
      },
    });
    expect(
      await parseCliJsonInput("-", "test-input", controller.signal, {
        stdin: stream,
      }),
    ).toMatchObject({
      ok: false,
      error: { input_path: "-", input_reason: "read-failed" },
    });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});

describe("CLI JSON file cleanup", () => {
  /** Refuse every close, recording each owner so the test can release it. */
  const refuseCloses = (onClose?: () => void) => {
    const owners = new Set<OwnedFileHandle>();
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        owners.add(this);
        onClose?.();
        throw new Error("injected file close failure");
      });
    onTestFinished(async () => {
      close.mockRestore();
      for (const owner of owners) await owner.close();
    });
    return { owners, close };
  };

  const jsonFile = async (prefix: string) => {
    const root = await createTestTempDirectory(prefix);
    const path = join(root, "input.json");
    await writeFile(path, '{"value":1}');
    return path;
  };

  it("retains a file whose close fails until final CLI cleanup", async () => {
    const path = await jsonFile("rea-json-input-close-");
    const { owners, close } = refuseCloses();
    expect(await parseCliJsonInput(path, "test-input")).toMatchObject({
      ok: false,
      error: {
        code: "cleanup_incomplete",
        input_path: path,
        details: { cleanup: "incomplete", resources: [path] },
      },
    });
    const [owner] = owners;
    // The handle stays with the process owner rather than being dropped.
    expect(owner?.handle.fd).toBeGreaterThanOrEqual(0);
    close.mockRestore();
    await closeCliResources();
    expect(owner?.handle.fd).toBe(-1);
  });

  it("keeps a cancellation recorded during close beside the incomplete cleanup", async () => {
    const path = await jsonFile("rea-json-input-close-cancel-");
    const controller = new AbortController();
    refuseCloses(() => controller.abort("stop"));
    expect(
      await parseCliJsonInput(path, "test-input", controller.signal),
    ).toMatchObject({
      ok: false,
      error: {
        code: "cleanup_incomplete",
        input_path: path,
        details: { cleanup: "incomplete", execution_failure: "cancelled" },
      },
    });
  });

  it("keeps a descriptor read failure beside the incomplete cleanup", async () => {
    const path = await jsonFile("rea-json-input-close-read-");
    const probe = await open(path);
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const read = vi
      .spyOn(prototype, "read")
      .mockRejectedValue(
        Object.assign(new Error("injected read failure"), { code: "EIO" }),
      );
    onTestFinished(() => read.mockRestore());
    refuseCloses();
    expect(await parseCliJsonInput(path, "test-input")).toMatchObject({
      ok: false,
      error: {
        code: "cleanup_incomplete",
        input_path: path,
        details: {
          cleanup: "incomplete",
          execution_failure: "invalid_request",
        },
      },
    });
  });
});
