import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { setImmediate as immediate } from "node:timers/promises";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { inspectElfDependenciesInputSchema } from "../../domain/native/elfDependencies.js";
import { elfDependencyFixture } from "./ElfDependencies.fixture.js";
import { ElfDependenciesProvider } from "./ElfDependenciesProvider.js";
import {
  ParseFailureError,
  malformedInput,
} from "../../domain/parseFailure.js";

vi.mock("node:timers/promises", async () => {
  const original = await vi.importActual<typeof import("node:timers/promises")>(
    "node:timers/promises",
  );
  return { ...original, setImmediate: vi.fn(original.setImmediate) };
});

afterEach(() => vi.mocked(immediate).mockClear());

it("keeps the read file's identity when parsing fails", async () => {
  const root = await createTestTempDirectory("rea-elf-dependencies-parse-");
  const path = join(root, "not-elf");
  const bytes = Buffer.from("not an ELF image, but it was read completely");
  await writeFile(path, bytes);
  const provider = new ElfDependenciesProvider();
  try {
    const result = await provider.inspect(
      inspectElfDependenciesInputSchema.parse({ path }),
    );
    if (result.ok) throw new Error("Expected a parse failure");
    expect(result.error.partialObservation).toEqual({
      kind: "file-snapshot-hash",
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
  } finally {
    await provider.close();
  }
});

const inspectFixture = async (bytes: Buffer) => {
  const root = await createTestTempDirectory("rea-elf-dependencies-limit-");
  const path = join(root, "program");
  await writeFile(path, bytes);
  const provider = new ElfDependenciesProvider();
  onTestFinished(() => provider.close());
  return (budgets: Record<string, number> = {}) =>
    provider.inspect(
      inspectElfDependenciesInputSchema.parse({ path, ...budgets }),
    );
};

const countLimitOf = (
  result: Awaited<ReturnType<ElfDependenciesProvider["inspect"]>>,
) => {
  if (result.ok) throw new Error("Expected a limit failure");
  expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
  const error = result.error as AnalysisResourceConstraintError;
  expect(error.retryable).toBe(false);
  expect(error.cause).toBeInstanceOf(ParseFailureError);
  return error.reportedLimits;
};

it.each([
  ["max_needed", 65536],
  ["max_versions", 65536],
  ["max_imports", 262144],
] as const)(
  "reports which budget failed and recovers when %s is raised",
  async (parameter, ceiling) => {
    const inspect = await inspectFixture(elfDependencyFixture());
    expect(countLimitOf(await inspect({ [parameter]: 2 }))).toMatchObject({
      boundary: parameter,
      maximum: 2,
      required: 3,
    });
    const raised = await inspect({ [parameter]: ceiling });
    if (!raised.ok) throw raised.error;
    expect(raised.value.coverage.status).toBe("complete");
  },
);

it("reports a fixed dynamic-symbol ceiling that a raised budget cannot clear", async () => {
  const imports = Array.from({ length: 262145 }, () => ({ name: "symbol" }));
  const inspect = await inspectFixture(elfDependencyFixture({ imports }));
  const ceiling = { boundary: "dynamic_symbols", maximum: 262144 };
  expect(countLimitOf(await inspect())).toMatchObject(ceiling);
  expect(countLimitOf(await inspect({ max_imports: 262144 }))).toMatchObject(
    ceiling,
  );
});

// A caller's abort reason is opaque: one that happens to be a parser failure
// must not turn the cancelled read into a malformed-target refusal.
it.each([
  { label: "default", reason: undefined },
  { label: "parser-failure", reason: malformedInput("elf", "caller reason") },
])(
  "cancels at a GNU hash checkpoint with a $label abort reason and remains reusable after cleanup",
  async ({ reason }) => {
    const root = await createTestTempDirectory(
      "rea-elf-dependencies-checkpoint-",
    );
    const path = join(root, "program");
    const bytes = elfDependencyFixture({
      stripped: true,
      omitHash: true,
      gnuHash: true,
    });
    await writeFile(path, bytes);
    const provider = new ElfDependenciesProvider();
    const controller = new AbortController();
    const original = await vi.importActual<
      typeof import("node:timers/promises")
    >("node:timers/promises");
    vi.mocked(immediate).mockImplementationOnce(async () => {
      controller.abort(reason);
      await original.setImmediate();
    });
    try {
      const input = inspectElfDependenciesInputSchema.parse({ path });
      const cancelled = await provider.inspect(input, {
        signal: controller.signal,
      });
      if (cancelled.ok)
        throw new Error("Expected cancellation at the hash checkpoint");
      expect(cancelled.error).toMatchObject({
        _tag: "AnalysisCancelledError",
        partialObservation: {
          kind: "file-snapshot-hash",
          path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
        },
      });
      expect(immediate).toHaveBeenCalledTimes(1);
      const retried = await provider.inspect(input);
      if (!retried.ok) throw retried.error;
      expect(retried.value.imports).toHaveLength(5);
    } finally {
      await provider.close();
    }
  },
);
