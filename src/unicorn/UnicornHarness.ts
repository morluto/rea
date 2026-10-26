import { createHash } from "node:crypto";

import type { AnalysisInputIssue } from "../domain/analysisErrorCore.js";
import { UNICORN_LIMITS } from "./UnicornRelease.js";
import type { EmulateFunctionInput } from "../contracts/unicorn/unicornToolContracts.js";

const PAGE_SIZE = 0x1000;

const alignUp = (size: number): number =>
  (size + PAGE_SIZE - 1) & ~(PAGE_SIZE - 1);

const issue = (
  path: readonly (string | number)[],
  reason: AnalysisInputIssue["reason"],
  message: string,
): AnalysisInputIssue => ({ path, reason, message });

interface NormalizedRegion {
  readonly start: number;
  readonly end: number;
  readonly label: string;
}

/**
 * Cross-field harness validation the contract schema cannot express:
 * page alignment, region overlap, stub placement, address-space budget, and
 * the optional function-bytes digest. Returns an empty list when valid.
 * The bridge re-validates everything (trust boundary); this runs first so
 * malformed harnesses fail without spawning a process.
 */
export const validateEmulationHarness = (
  input: EmulateFunctionInput,
): readonly AnalysisInputIssue[] => {
  const issues: AnalysisInputIssue[] = [];
  const functionBytes = Buffer.from(input.function_bytes, "hex");

  if (input.code_address % PAGE_SIZE !== 0)
    issues.push(
      issue(
        ["code_address"],
        "invalid_value",
        "code_address must be page-aligned.",
      ),
    );
  if (input.stack_address % PAGE_SIZE !== 0)
    issues.push(
      issue(
        ["stack_address"],
        "invalid_value",
        "stack_address must be page-aligned.",
      ),
    );
  if (input.entry_offset >= functionBytes.length)
    issues.push(
      issue(
        ["entry_offset"],
        "out_of_range",
        "entry_offset is past the end of function_bytes.",
      ),
    );

  const regions: NormalizedRegion[] = [
    {
      start: input.code_address,
      end: input.code_address + alignUp(functionBytes.length),
      label: "code",
    },
    {
      start: input.stack_address,
      end: input.stack_address + alignUp(input.stack_size),
      label: "stack",
    },
  ];
  let totalInputBytes = functionBytes.length;
  input.memory.forEach((region, index) => {
    if (region.address % PAGE_SIZE !== 0)
      issues.push(
        issue(
          ["memory", index, "address"],
          "invalid_value",
          "memory region addresses must be page-aligned.",
        ),
      );
    const data = Buffer.from(region.bytes, "hex");
    totalInputBytes += data.length;
    regions.push({
      start: region.address,
      end: region.address + alignUp(data.length),
      label: `memory[${index}]`,
    });
  });
  if (totalInputBytes > UNICORN_LIMITS.inputBytes)
    issues.push(
      issue(
        ["function_bytes"],
        "out_of_range",
        `Total harness input exceeds ${String(UNICORN_LIMITS.inputBytes)} bytes.`,
      ),
    );

  const ordered = [...regions].sort((a, b) => a.start - b.start);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (current.start < previous.end)
      issues.push(
        issue(
          ["memory"],
          "invalid_value",
          `Memory regions overlap: ${previous.label} and ${current.label}.`,
        ),
      );
  }

  let mappedTotal = 0;
  for (const region of regions) mappedTotal += region.end - region.start;
  const stubPages = new Set<number>();
  for (const key of Object.keys(input.stubs)) {
    const address = Number.parseInt(key, 16);
    const page = address & ~(PAGE_SIZE - 1);
    stubPages.add(page);
    if (regions.some((region) => page >= region.start && page < region.end))
      issues.push(
        issue(
          ["stubs"],
          "invalid_value",
          `Stub address ${key} falls inside a declared memory region.`,
        ),
      );
  }
  mappedTotal += stubPages.size * PAGE_SIZE;
  if (mappedTotal > input.budgets.address_space_bytes)
    issues.push(
      issue(
        ["budgets", "address_space_bytes"],
        "out_of_range",
        "Mapped address space exceeds the declared budget.",
      ),
    );

  if (input.function_sha256 !== undefined) {
    const digest = createHash("sha256").update(functionBytes).digest("hex");
    if (digest !== input.function_sha256)
      issues.push(
        issue(
          ["function_sha256"],
          "invalid_value",
          "function_sha256 does not match the supplied function_bytes.",
        ),
      );
  }
  return issues;
};
