import { registerCliCommand } from "../../../src/cli/commandRegistry.js";
import { createCommandCli } from "../../support/cli/commandCli.js";
import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { parseCliOutputArguments } from "../../../src/cli/cliOutput.js";
import { createCliResultOutput } from "../../../src/cli/cliResultOutput.js";
import {
  cliOperationFailureIdentity,
  cliOperationFailurePayload,
  logCliCommand,
} from "../../../src/cliLogging.js";
import { analysisErrorProjectionSchema } from "../../../src/domain/analysisErrorProjectionSchema.js";
import { ArtifactOperationError } from "../../../src/domain/artifactOperationError.js";
import { silentLogger } from "../../../src/logger.js";
import {
  cliEvidencePublicationReceipt,
  recordCliEvidencePublication,
  withCliEvidencePublication,
} from "../../../src/cli/cliEvidencePublication.js";

const metadata = { command: "fixture", duration: "1ms" };

/** Fail at the formatter boundary after the command has returned its result. */
const formattingFailureValue = (
  cause = new RangeError("Invalid string length"),
) =>
  new Proxy(
    {},
    {
      ownKeys: () => {
        throw cause;
      },
    },
  );

it("keeps receipts isolated across concurrent invocations", async () => {
  const results = await Promise.all(
    ["first", "second"].map((path) =>
      withCliEvidencePublication(async () => {
        recordCliEvidencePublication({ path, bytes: 1 });
        await Promise.resolve();
        return cliEvidencePublicationReceipt();
      }),
    ),
  );
  expect(results).toEqual([
    { path: "first", bytes: 1 },
    { path: "second", bytes: 1 },
  ]);
  expect(cliEvidencePublicationReceipt()).toBeUndefined();
});

it("retains a publication receipt after formatting recovery leaves the invocation context", async () => {
  const chunks: Buffer[] = [];
  const output = createCliResultOutput(
    parseCliOutputArguments([]),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    }),
  );
  if (output === undefined) throw new Error("Missing output owner");
  await withCliEvidencePublication(async () => {
    recordCliEvidencePublication({ path: "/tmp/result.json", bytes: 123 });
    expect(await output.write(formattingFailureValue(), metadata)).toBe(true);
  });
  expect(cliEvidencePublicationReceipt()).toBeUndefined();
  expect(
    await output.recoverFormattingFailure(
      new RangeError("Invalid string length"),
    ),
  ).toBe(false);
  expect(output.error).toMatchObject({
    code: "resource_constraint",
    details: {
      diagnostics: {
        evidence_bundle: { path: "/tmp/result.json", bytes: 123 },
      },
    },
  });
  expect(Buffer.concat(chunks).toString("utf8")).toContain("/tmp/result.json");
});

it.each([
  { format: "md", value: "\u0000", window: false },
  { format: "toon", value: "\ud800", window: false },
  { format: "toon", value: "\ud800", window: true },
] as const)(
  "retains the committed receipt when $format cannot encode output (token window: $window)",
  async ({ format, value, window }) => {
    const chunks: Buffer[] = [];
    const receipt = { path: "/authored/retained.json", bytes: 123 };
    const output = createCliResultOutput(
      parseCliOutputArguments([
        "--format",
        format,
        ...(window ? ["--token-limit", "1000"] : []),
      ]),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      }),
    );
    if (output === undefined) throw new Error("Missing output owner");
    await withCliEvidencePublication(async () => {
      recordCliEvidencePublication(receipt);
      expect(await output.write({ value }, metadata)).toBe(true);
    });
    expect(output.error).toMatchObject({
      code: "invalid_request",
      details: { diagnostics: { evidence_bundle: receipt } },
    });
    expect(Buffer.concat(chunks).toString("utf8")).toContain(receipt.path);
  },
);

describe("CLI formatting stage admission", () => {
  it("captures thrown integrity failures without re-reading diagnostics during recovery", async () => {
    const previousExitCode = process.exitCode;
    try {
      const value = await logCliCommand(silentLogger, "fixture", async () => {
        throw new ArtifactOperationError("inspect_artifact", "integrity", {
          logicalPath: "entry.js",
          declaredSha256: "a".repeat(64),
          calculatedSha256: "b".repeat(64),
          unpacked: false,
        });
      });
      // A second traversal would be observable here. The producer already
      // classified this exact projection before the formatter sees it.
      Object.defineProperty(value, "details", {
        get() {
          throw new Error("Diagnostics were interpreted again");
        },
      });
      expect(cliOperationFailurePayload(value)).toBe(value);
      expect(cliOperationFailureIdentity(value)).toEqual({
        code: "artifact_integrity_mismatch",
        category: "integrity_mismatch",
        retryable: false,
      });
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("declines errors before a result or from a different failure class", async () => {
    const output = createCliResultOutput(
      parseCliOutputArguments([]),
      new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
    );
    expect(output).toBeDefined();
    expect(
      await output?.recoverFormattingFailure(
        new RangeError("Invalid string length"),
      ),
    ).toBe(false);
    await output?.write({ result: "completed" }, metadata);
    for (const cause of [
      new Error("Invalid string length"),
      new RangeError("Maximum call stack size exceeded"),
      new Error("operation failed"),
    ])
      expect(await output?.recoverFormattingFailure(cause)).toBe(false);
    expect(output?.handled).toBe(true);
  });

  it("keeps command RangeErrors distinct from post-result formatting capacity failures", async () => {
    const output = createCliResultOutput(
      parseCliOutputArguments([]),
      new Writable(),
    );
    if (output === undefined) throw new Error("Missing output owner");
    const cli = createCommandCli(output);
    registerCliCommand(cli, "fixture", {
      run: () => {
        throw new RangeError("Invalid string length");
      },
    });
    let text = "";
    let status = 0;
    await cli.serve(["fixture"], {
      stdout: (part) => {
        text += part;
      },
      exit: (code) => {
        status = code;
      },
    });
    expect(status).toBe(1);
    expect(text).toContain("UNKNOWN");
    expect(text).not.toContain("resource_constraint");
    expect(output.error).toBeUndefined();
  });
});

describe("CLI formatting recovery outcomes", () => {
  it("formats a recovered Markdown result through the CLI Markdown owner", async () => {
    const cause = new RangeError("Invalid string length");
    const chunks: Buffer[] = [];
    const output = createCliResultOutput(
      parseCliOutputArguments(["--format", "md"]),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      }),
    );
    const value = new Proxy(
      {},
      {
        ownKeys: () => {
          throw cause;
        },
      },
    );

    expect(await output?.write(value, { ...metadata })).toBe(true);
    expect(output?.error).toMatchObject({ code: "resource_constraint" });
    const text = Buffer.concat(chunks).toString("utf8");
    expect(text).toContain("resource_constraint");
    expect(text).toContain("original result was not written");
    expect(output?.failed).toBe(false);
  });

  it("retains ownership if the recovery document cannot be written", async () => {
    const cause = new RangeError("Invalid string length");
    const output = createCliResultOutput(
      parseCliOutputArguments([]),
      new Writable({
        write(_chunk, _encoding, callback) {
          callback(cause);
        },
      }),
    );
    await expect(
      output?.write(formattingFailureValue(cause), metadata),
    ).rejects.toBe(cause);
    expect(output?.handled).toBe(true);
    expect(output?.failed).toBe(true);
    expect(await output?.recoverFormattingFailure(cause)).toBe(false);
  });

  it("does not replace a failed destination, even for the same RangeError", async () => {
    const cause = new RangeError("Invalid string length");
    const output = createCliResultOutput(
      parseCliOutputArguments(["--json"]),
      new Writable({
        write(_chunk, _encoding, callback) {
          callback(cause);
        },
      }),
    );
    await expect(
      output?.write({ result: "completed" }, { ...metadata }),
    ).rejects.toBe(cause);
    expect(output?.handled).toBe(true);
    expect(output?.failed).toBe(true);
    expect(await output?.recoverFormattingFailure(cause)).toBe(false);
  });

  it("retains the original failure identity and ignores large details on recovery", async () => {
    const chunks: Buffer[] = [];
    const output = createCliResultOutput(
      parseCliOutputArguments([]),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      }),
    );
    const previousExitCode = process.exitCode;
    try {
      const value = await logCliCommand(silentLogger, "fixture", async () => ({
        code: "target_unavailable",
        category: "unavailable",
        message: "The operation did not complete.",
        retryable: false,
        remediation: { action: "Check the selected path." },
        details: { partial_observation: { text: "captured" } },
      }));
      Object.defineProperty(value, "details", {
        get() {
          throw new RangeError("Invalid string length");
        },
      });
      expect(await output?.write(value, metadata)).toBe(true);
      expect(output?.error).toMatchObject({
        code: "resource_constraint",
        details: {
          resource: "memory",
          reported_limits: {
            formatted_characters: null,
            original_failure: {
              code: "target_unavailable",
              category: "unavailable",
            },
          },
        },
      });
      const text = Buffer.concat(chunks).toString("utf8");
      expect(text).toContain("--format json");
      expect(text).not.toContain("partial_observation");
      expect(
        await output?.recoverFormattingFailure(
          new RangeError("Invalid string length"),
        ),
      ).toBe(false);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});

// Every CLI presentation recovers a post-result string-capacity failure the
// same way. tests/acceptance/cliFormattingCapacity.test.ts keeps one real
// process per encoder boundary and outcome; this table checks each
// presentation's recovery document in process.
describe("CLI formatting capacity recovery for each presentation", () => {
  const presentations = [
    { name: "default TOON", arguments: [] },
    { name: "human TOON", arguments: [], terminal: true },
    { name: "full TOON", arguments: ["--full-output"] },
    { name: "TOON token count", arguments: ["--token-count"] },
    { name: "TOON token window", arguments: ["--token-limit", "3"] },
    {
      name: "full TOON token window",
      arguments: ["--full-output", "--token-limit", "3"],
    },
    { name: "YAML", arguments: ["--format", "yaml"] },
    { name: "full YAML", arguments: ["--format", "yaml", "--full-output"] },
    { name: "Markdown", arguments: ["--format", "md"] },
    { name: "full Markdown", arguments: ["--format", "md", "--full-output"] },
    {
      name: "Markdown token window",
      arguments: ["--format", "md", "--token-limit", "3"],
    },
  ] as const;

  /** A completed command failure whose details exceed a runtime string. */
  const oversizedFailure = async () => {
    const previousExitCode = process.exitCode;
    try {
      const value = await logCliCommand(silentLogger, "fixture", async () => ({
        code: "target_unavailable",
        category: "unavailable",
        message: "The operation did not complete.",
        retryable: false,
        remediation: { action: "Check the selected path." },
        details: {},
      }));
      Object.defineProperty(value, "details", {
        get() {
          throw new RangeError("Invalid string length");
        },
      });
      return value;
    } finally {
      process.exitCode = previousExitCode;
    }
  };

  it.for(
    presentations.flatMap((presentation) =>
      (["success", "failure"] as const).map((outcome) => ({
        ...presentation,
        outcome,
      })),
    ),
  )(
    "$name returns a typed formatting constraint after $outcome",
    async ({ outcome, ...presentation }) => {
      const chunks: Buffer[] = [];
      const destination = Object.assign(
        new Writable({
          write(chunk: Buffer, _encoding, callback) {
            chunks.push(chunk);
            callback();
          },
        }),
        { isTTY: "terminal" in presentation },
      );
      const options = parseCliOutputArguments(presentation.arguments);
      const output = createCliResultOutput(options, destination);
      if (output === undefined) throw new Error("Missing output owner");
      const value =
        outcome === "success"
          ? // The envelope reads the result's top level; only encoding
            // reaches the nested value.
            { result: formattingFailureValue() }
          : await oversizedFailure();
      const previousExitCode = process.exitCode;
      try {
        expect(await output.write(value, metadata)).toBe(true);
      } finally {
        process.exitCode = previousExitCode;
      }
      expect(output.failed).toBe(false);
      expect(output.error).toMatchObject({
        code: "resource_constraint",
        retryable: false,
        details: {
          resource: "memory",
          reported_limits: {
            format: options.format,
            formatted_characters: null,
            ...(outcome === "failure"
              ? {
                  original_failure: {
                    code: "target_unavailable",
                    category: "unavailable",
                  },
                }
              : {}),
          },
        },
      });
      const text = Buffer.concat(chunks).toString("utf8");
      expect(text).toContain("resource_constraint");
      expect(text).toContain("--format json");
      expect(text).toContain("formatted_characters");
      expect(text).not.toContain("[truncated:");
      if (outcome === "failure") expect(text).toContain("target_unavailable");
      // Only the full-output envelope carries the invocation's meta.duration.
      if (options.fullOutput) expect(text).toContain(metadata.duration);
      else expect(text).not.toContain(metadata.duration);
      if (options.format === "yaml") {
        const document: unknown = parseYaml(text);
        const recovered = options.fullOutput
          ? (document as { error: unknown }).error
          : document;
        expect(analysisErrorProjectionSchema.parse(recovered)).toMatchObject({
          code: "resource_constraint",
          details: { reported_limits: { formatted_characters: null } },
        });
        if (options.fullOutput)
          expect(document).toMatchObject({
            ok: false,
            meta: { command: "fixture" },
          });
      }
      if (options.format === "md" && options.fullOutput) {
        expect(text).toMatch(/^## ok\n\nfalse$/m);
        expect(text).toMatch(/^## error\.code\n\nresource_constraint$/m);
      }
    },
  );
});
