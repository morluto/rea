import { z } from "zod";

const architectureSchema = z.object({
  name: z.string().min(1),
  cpu_type: z.string().nullable(),
  cpu_subtype: z.string().nullable(),
  cpu_type_code: z.number().int().nonnegative().nullable(),
  cpu_subtype_code: z.number().int().nonnegative().nullable(),
  capabilities: z.string().nullable(),
  file_offset: z.number().int().min(0).nullable(),
  size: z.number().int().min(0).nullable(),
  alignment: z.number().int().min(0).nullable(),
});

export type LipoArchitecture = z.infer<typeof architectureSchema>;

/** Parse `lipo -detailed_info` into deterministic slice metadata. */
export const parseLipoArchitectures = (output: string): LipoArchitecture[] => {
  // lipo echoes a thin file's pathname verbatim, including embedded newlines.
  // Match its final architecture field before splitting records into lines.
  const thinArchitecture =
    /(?:^|\r?\n)Non-fat file:[\s\S]* is architecture: ([^\s]+)\s*$/u.exec(
      output,
    )?.[1];
  if (thinArchitecture !== undefined)
    return [
      architectureSchema.parse({
        name: thinArchitecture,
        cpu_type: null,
        cpu_subtype: null,
        cpu_type_code: null,
        cpu_subtype_code: null,
        capabilities: null,
        file_offset: null,
        size: null,
        alignment: null,
      }),
    ];
  const architectures: LipoArchitecture[] = [];
  let current: Record<string, string> | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    const name = current.architecture ?? current["Non-fat file"];
    if (name !== undefined)
      architectures.push(
        architectureSchema.parse({
          name: name.includes(" is architecture: ")
            ? (name.split(" is architecture: ").at(-1) ?? name)
            : name,
          cpu_type: current.cputype ?? null,
          cpu_subtype: current.cpusubtype ?? null,
          cpu_type_code: cpuTypeCode(current.cputype),
          cpu_subtype_code: cpuSubtypeCode(
            current.cpusubtype,
            current.capabilities,
          ),
          capabilities: current.capabilities ?? null,
          file_offset: integer(current.offset),
          size: integer(current.size),
          alignment: alignment(current.align),
        }),
      );
    current = undefined;
  };
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith("Non-fat file:")) {
      flush();
      current = { "Non-fat file": line };
      continue;
    }
    if (line.startsWith("architecture ")) {
      flush();
      current = { architecture: line.slice("architecture ".length).trim() };
      continue;
    }
    const match =
      /^(cputype|cpusubtype|capabilities|offset|size|align)\s+(.+)$/u.exec(
        line,
      );
    if (match?.[1] !== undefined && match[2] !== undefined) {
      current ??= {};
      current[match[1]] = match[2].trim();
    }
  }
  flush();
  if (architectures.length === 0)
    throw new TypeError("lipo output contained no architectures");
  return architectures;
};

const integer = (value: string | undefined): number | null => {
  if (value === undefined || !/^\d+$/u.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const CPU_TYPES: Readonly<Record<string, number>> = {
  CPU_TYPE_X86: 7,
  CPU_TYPE_X86_64: 0x01000007,
  CPU_TYPE_ARM: 12,
  CPU_TYPE_ARM64: 0x0100000c,
  CPU_TYPE_ARM64_32: 0x0200000c,
  CPU_TYPE_POWERPC: 18,
  CPU_TYPE_POWERPC64: 0x01000012,
};

const CPU_SUBTYPES: Readonly<Record<string, number>> = {
  CPU_SUBTYPE_X86_ALL: 3,
  CPU_SUBTYPE_X86_64_ALL: 3,
  CPU_SUBTYPE_X86_64_H: 8,
  CPU_SUBTYPE_ARM64_ALL: 0,
  CPU_SUBTYPE_ARM64_V8: 1,
  CPU_SUBTYPE_ARM64E: 2,
  CPU_SUBTYPE_ARM64_32_ALL: 0,
  CPU_SUBTYPE_ARM64_32_V8: 1,
  CPU_SUBTYPE_ARM_V7: 9,
  CPU_SUBTYPE_ARM_V7S: 11,
  CPU_SUBTYPE_ARM_V7K: 12,
  CPU_SUBTYPE_POWERPC_ALL: 0,
  CPU_SUBTYPE_POWERPC_970: 100,
};

/** Normalize known lipo names while retaining the producer's original text. */
const cpuTypeCode = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const numeric = unsigned32(value);
  return numeric ?? CPU_TYPES[value] ?? null;
};

/** Normalize the subtype and its separately printed ptrauth capability bits. */
const cpuSubtypeCode = (
  value: string | undefined,
  capabilities: string | undefined,
): number | null => {
  if (value === undefined) return null;
  const numeric = unsigned32(value);
  if (numeric !== null) return numeric;
  const subtype = CPU_SUBTYPES[value];
  if (subtype === undefined) return null;
  if (value !== "CPU_SUBTYPE_ARM64E") return subtype;
  const version = /PTR_AUTH_VERSION\s+USERSPACE\s+(\d+)/u.exec(
    capabilities ?? "",
  )?.[1];
  if (version === undefined) return null;
  const parsedVersion = Number(version);
  if (
    !Number.isInteger(parsedVersion) ||
    parsedVersion < 0 ||
    parsedVersion > 15
  )
    return null;
  return (0x80000000 | (parsedVersion << 24) | subtype) >>> 0;
};

const unsigned32 = (value: string): number | null => {
  if (!/^(?:\d+|0x[\da-f]+)$/iu.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffffffff
    ? parsed >>> 0
    : null;
};

const alignment = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const exponent = /^2\^(\d+)(?: \((\d+)\))?$/u.exec(value);
  const powerText = exponent?.[1];
  if (powerText !== undefined) {
    const power = Number.parseInt(powerText, 10);
    if (power > 52) return null;
    const alignment = 2 ** power;
    const reported = exponent?.[2];
    return reported === undefined || integer(reported) === alignment
      ? alignment
      : null;
  }
  return integer(value);
};
