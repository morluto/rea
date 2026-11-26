import { expect } from "vitest";

interface Probe {
  readonly operation: string;
  readonly authority: string;
}

/** The format-specific static reader that identifies each native carrier. */
export const CARRIER_READER = {
  elf: "inspect_elf_dependencies",
  "mach-o": "inspect_macho",
  pe: "inspect_pe_imports",
} as const;

/**
 * Assert the ordering facts for a package carried by a native image: any
 * package readers lead, the carrier's execution-free readers follow, and the
 * deep native provider comes last as the only probe beyond artifact bytes.
 * The complete per-format reader list is owned by the native image probe test.
 */
export const expectCarrierProbes = (
  probes: readonly Probe[],
  carrier: keyof typeof CARRIER_READER,
  packageReaders: readonly string[] = [],
): void => {
  const operations = probes.map(({ operation }) => operation);
  expect(operations.slice(0, packageReaders.length)).toEqual(packageReaders);
  expect(operations.slice(packageReaders.length)).toContain(
    CARRIER_READER[carrier],
  );
  expect(
    probes.filter(({ authority }) => authority !== "artifact-bytes"),
  ).toEqual([probes.at(-1)]);
  expect(probes.at(-1)).toMatchObject({
    operation: "open_binary",
    authority: "native-analysis-provider",
  });
};
