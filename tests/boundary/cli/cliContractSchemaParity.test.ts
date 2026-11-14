import { readFileSync } from "node:fs";
import { Cli } from "incur";
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

/** CLI commands whose name differs from the one contract they reach. */
const COMMAND_CONTRACT_ALIASES: Readonly<Record<string, string>> = {
  "environment-build": "export_environment_bundle",
  analyze: "binary_overview",
  inspect: "binary_overview",
  decompile: "procedure_pseudo_code",
  function: "analyze_function",
  instructions: "read_function_instructions",
  trace: "trace_feature",
  "capture-process": "capture_process_scenario",
  compare: "compare_bundles",
  "debug-with-gdb": "gdb_console",
  "debug-with-rizin": "rizin_debug_command",
};

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

/** Probes that exercise refusals of one contract field. */
const probesFor = (contract: z.ZodType): readonly Probe[] => {
  const probes: Probe[] = [];
  const text = admits(contract, "x")
    ? "x"
    : admits(contract, ABSOLUTE)
      ? ABSOLUTE
      : undefined;
  if (text !== undefined) {
    if (!admits(contract, ""))
      probes.push({ id: "empty", value: "", expect: "refused" });
    if (!admits(contract, `${text}\u0000`))
      probes.push({ id: "nul", value: `${text}\u0000`, expect: "refused" });
    if (text === ABSOLUTE && refusesAsRelativeHostPath(contract))
      probes.push({ id: "relative", value: RELATIVE, expect: "resolved" });
  }
  if (admits(contract, 0) || admits(contract, 1))
    for (const value of NUMERIC_SPELLINGS)
      probes.push({
        id: `numeric:${JSON.stringify(value)}`,
        value,
        expect: "refused",
      });
  return probes;
};

const snake = (name: string): string =>
  name.replaceAll("-", "_").replace(/[A-Z]/gu, (c) => `_${c.toLowerCase()}`);

/** The object shape a contract validates, through refinements and pipes. */
const contractShape = (
  schema: z.ZodType,
): Readonly<Record<string, z.ZodType>> | undefined => {
  let current: unknown = schema;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof z.ZodObject)
      return current.shape as Record<string, z.ZodType>;
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
  const commands = Cli.toCommands.get(
    cli as unknown as Parameters<typeof Cli.toCommands.get>[0],
  );
  if (commands === undefined) throw new Error("No CLI commands registered");
  const contracts = new Map<string, z.ZodType>(
    TOOL_CONTRACTS.map((contract) => [contract.name, contract.inputSchema]),
  );
  const mismatches: string[] = [];
  let compared = 0;
  let commandsCompared = 0;
  let unmatchedFields = 0;
  for (const [name, entry] of commands) {
    if ("_alias" in entry) continue;
    const contractName = COMMAND_CONTRACT_ALIASES[name] ?? snake(name);
    const contract = contracts.get(contractName);
    if (contract === undefined) continue;
    const shape = contractShape(contract);
    if (shape === undefined) continue;
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
  return {
    mismatches: mismatches.sort(),
    compared,
    commandsCompared,
    unmatchedFields,
  };
};

describe("CLI and contract field admission parity", () => {
  it("admits no new value the contract refuses, and the baseline only shrinks", () => {
    const { mismatches, compared, commandsCompared } = collectParity();
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
