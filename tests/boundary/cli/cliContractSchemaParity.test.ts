import { readFileSync } from "node:fs";
import {
  cliCommands,
  commandOwnOperations,
} from "../../../src/cli/commandRegistry.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createCli } from "../../../src/cli.js";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";

/**
 * Report-only parity between each CLI command's own field schemas and the MCP
 * contract it reaches. A CLI field that admits a value its contract refuses
 * fails late, under the wrong field name, or not at all. Mismatches already on
 * main are recorded in the baseline, which may only shrink: a new mismatch
 * fails, and so does a recorded one that no longer occurs.
 *
 * Fields are matched by mechanical name (camelCase or kebab-case to
 * snake_case). Renamed fields cannot be compared yet (W1 derives CLI fields
 * from contracts). Remove an entry from the baseline once its drift is fixed.
 */

const BASELINE_CEILING = 16;
const BASELINE_URL = new URL(
  "./cliContractSchemaParity.baseline.json",
  import.meta.url,
);

type Probe = {
  readonly id: string;
  readonly value: unknown;
  /**
   * "refused": the contract refuses the value, so the CLI must refuse it too.
   * "resolved": the CLI resolves a caller-relative host path before the
   * contract sees it, so the CLI must admit the spelling the contract refuses.
   */
  readonly expect: "refused" | "resolved";
};

const admits = (schema: z.ZodType, value: unknown): boolean =>
  schema.safeParse(value).success;

const ABSOLUTE = process.platform === "win32" ? "C:\\rea\\x" : "/rea/x";
const RELATIVE = "rea/x";

/** The host-path owner's refusal of a relative spelling (src/domain/localPath.ts). */
const refusesAsRelativeHostPath = (contract: z.ZodType): boolean =>
  contract
    .safeParse(RELATIVE)
    .error?.issues.some(({ message }) =>
      message.includes("absolute local filesystem path"),
    ) === true;

/** Numeric argv spellings: signs, exponents, radixes, separators, overflow. */
const NUMERIC_SPELLINGS = [
  "01",
  "+1",
  "1e3",
  "0x10",
  "1.5",
  " 1",
  "-1",
  "1_000",
  "99999999999999999999",
] as const;

/** The schema a field validates after optional, default, pipe and similar wrappers. */
const innermost = (contract: z.ZodType): unknown => {
  let current: unknown = contract;
  for (
    let depth = 0;
    depth < 8 &&
    !(current instanceof z.ZodString) &&
    !(current instanceof z.ZodNumber);
    depth += 1
  ) {
    const def = (current as { _zod?: { def?: Record<string, unknown> } })?._zod
      ?.def;
    const inner = def?.["in"] ?? def?.["innerType"] ?? def?.["schema"];
    if (inner === undefined) break;
    current = inner;
  }
  return current;
};

/** Probes that exercise refusals of one contract field. */
const probesFor = (contract: z.ZodType): readonly Probe[] => {
  const probes: Probe[] = [];
  const unwrapped = innermost(contract);
  const text = admits(contract, "x")
    ? "x"
    : admits(contract, ABSOLUTE)
      ? ABSOLUTE
      : undefined;
  if (unwrapped instanceof z.ZodString && !admits(contract, ""))
    probes.push({ id: "empty", value: "", expect: "refused" });
  if (
    unwrapped instanceof z.ZodString &&
    !admits(contract, `${text ?? "x"}\u0000`)
  )
    probes.push({
      id: "nul",
      value: `${text ?? "x"}\u0000`,
      expect: "refused",
    });
  if (text !== undefined) {
    if (text === ABSOLUTE && refusesAsRelativeHostPath(contract))
      probes.push({ id: "relative", value: RELATIVE, expect: "resolved" });
  }
  // Numeric fields are identified by type, not by admitting 0 or 1, so a
  // range such as 256..65536 is probed too, including just past each bound.
  const numeric = unwrapped instanceof z.ZodNumber;
  if (numeric || admits(contract, 0) || admits(contract, 1)) {
    const minValue = numeric ? unwrapped.minValue : null;
    const maxValue = numeric ? unwrapped.maxValue : null;
    const bounds = [
      ...(minValue === null || !Number.isFinite(minValue)
        ? []
        : [String(minValue - 1)]),
      ...(maxValue === null || !Number.isFinite(maxValue)
        ? []
        : [String(maxValue + 1)]),
    ].filter((value) => !admits(contract, Number(value)));
    for (const value of [...NUMERIC_SPELLINGS, ...bounds])
      probes.push({
        id: `numeric:${JSON.stringify(value)}`,
        value,
        expect: "refused",
      });
  }
  return probes;
};

const snake = (name: string): string =>
  name.replaceAll("-", "_").replace(/[A-Z]/gu, (c) => `_${c.toLowerCase()}`);

/** The object shape a contract validates, through refinements and pipes. */
const contractShape = (
  schema: unknown,
): Readonly<Record<string, z.ZodType>> | undefined => {
  let current: unknown = schema;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof z.ZodObject)
      return current.shape as Record<string, z.ZodType>;
    if (current instanceof z.ZodUnion) {
      const shapes = current.options.map((option) => contractShape(option));
      const first = shapes[0];
      if (first === undefined || shapes.some((shape) => shape === undefined))
        return undefined;
      const common = Object.fromEntries(
        Object.entries(first).filter(([key, value]) =>
          shapes.every((shape) => shape?.[key] === value),
        ),
      );
      return Object.keys(common).length === 0 ? undefined : common;
    }
    const def = (current as { _zod?: { def?: Record<string, unknown> } })._zod
      ?.def;
    const inner = def?.["in"] ?? def?.["innerType"] ?? def?.["schema"];
    if (inner === undefined) return undefined;
    current = inner;
  }
  return undefined;
};

/** One CLI token as incur passes it: a single argv string or the value. */
const cliAdmittedValue = (
  field: z.ZodType,
  value: unknown,
): { readonly admitted: boolean; readonly value?: unknown } => {
  const parsed = field.safeParse(value);
  return parsed.success
    ? { admitted: true, value: parsed.data }
    : { admitted: false };
};

const collectParity = () => {
  const cli = createCli();
  const commands = cliCommands(cli);
  const contracts = new Map<string, z.ZodType>(
    TOOL_CONTRACTS.map((contract) => [contract.name, contract.inputSchema]),
  );
  const mismatches: string[] = [];
  const uncomparable: string[] = [];
  let compared = 0;
  let commandsCompared = 0;
  let unmatchedFields = 0;
  for (const command of commands) {
    const { name, definition: entry } = command;
    const ownOperations = commandOwnOperations(command);
    const contractNames: readonly string[] =
      ownOperations.length > 0
        ? ownOperations.map((operation) => operation.name)
        : [snake(name)];
    for (const contractName of contractNames) {
      const contract = contracts.get(contractName);
      if (contract === undefined) {
        uncomparable.push(`${name}: no contract ${contractName}`);
        continue;
      }
      const shape = contractShape(contract);
      if (shape === undefined) {
        uncomparable.push(`${name}: no object shape ${contractName}`);
        continue;
      }
      commandsCompared += 1;
      for (const group of ["args", "options"] as const) {
        const declared = (entry as unknown as Record<string, unknown>)[group];
        const fields: Readonly<Record<string, z.ZodType>> =
          declared instanceof z.ZodObject
            ? (declared.shape as Record<string, z.ZodType>)
            : {};
        for (const [fieldName, cliField] of Object.entries(fields)) {
          const contractField = shape[snake(fieldName)];
          if (contractField === undefined) {
            unmatchedFields += 1;
            continue;
          }
          for (const probe of probesFor(contractField)) {
            compared += 1;
            const cliValue = cliAdmittedValue(cliField, probe.value);
            const mismatch =
              probe.expect === "resolved"
                ? !cliValue.admitted
                : cliValue.admitted && !admits(contractField, cliValue.value);
            if (mismatch)
              mismatches.push(`${name} ${group}.${fieldName} ${probe.id}`);
          }
        }
      }
    }
  }
  return {
    mismatches: [...new Set(mismatches)].sort(),
    compared,
    commandsCompared,
    unmatchedFields,
    uncomparable,
  };
};

describe("CLI and contract field admission parity", () => {
  it("probes constrained strings without needing a valid sample", () => {
    const probes = probesFor(z.string().regex(/^[a-f0-9]{64}$/u));
    expect(probes.map(({ id }) => id)).toEqual(["empty", "nul"]);
  });
  it("probes numeric fields whose range admits neither 0 nor 1", () => {
    const ids = probesFor(z.number().int().min(256).max(65536).optional()).map(
      ({ id }) => id,
    );
    expect(ids).toEqual(
      expect.arrayContaining([
        'numeric:"-1"',
        'numeric:"99999999999999999999"',
        'numeric:"255"',
        'numeric:"65537"',
      ]),
    );
  });
  it("compares union fields shared by every operation", () => {
    const limit = z.number().int().positive();
    const schema = z.discriminatedUnion("operation", [
      z.object({ operation: z.literal("one"), limit }),
      z.object({ operation: z.literal("two"), limit }),
    ]);
    expect(contractShape(schema)).toEqual({ limit });
  });
  it("admits no new value the contract refuses, and the baseline only shrinks", () => {
    const { mismatches, compared, commandsCompared, uncomparable } =
      collectParity();
    // CLI-only commands and non-object contract unions require a different comparison.
    expect(uncomparable).toEqual(
      JSON.parse(
        readFileSync(
          new URL(
            "./cliContractSchemaParity.uncomparable.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
    // Guard against a vacuous run, such as a CLI that registers nothing.
    expect(commandsCompared).toBeGreaterThan(100);
    expect(compared).toBeGreaterThan(500);
    const baseline = JSON.parse(
      readFileSync(BASELINE_URL, "utf8"),
    ) as readonly string[];
    // The recorded count can only go down; raise it only with a reviewed reason.
    expect(baseline.length).toBeLessThanOrEqual(BASELINE_CEILING);
    expect(new Set(baseline).size).toBe(baseline.length);
    const recorded = new Set(baseline);
    const observed = new Set(mismatches);
    expect(
      mismatches.filter((entry) => !recorded.has(entry)),
      "new CLI fields that admit values their contract refuses",
    ).toEqual([]);
    expect(
      baseline.filter((entry) => !observed.has(entry)),
      "fixed mismatches still listed in the baseline; remove them",
    ).toEqual([]);
  });
});
