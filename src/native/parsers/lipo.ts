import { z } from "zod";

const architectureSchema = z.object({
  name: z.string().min(1),
  cpu_type: z.string().nullable(),
  cpu_subtype: z.string().nullable(),
  file_offset: z.number().int().min(0).nullable(),
  size: z.number().int().min(0).nullable(),
  alignment: z.number().int().min(0).nullable(),
});

export type LipoArchitecture = z.infer<typeof architectureSchema>;

/** Parse `lipo -detailed_info` into deterministic slice metadata. */
export const parseLipoArchitectures = (output: string): LipoArchitecture[] => {
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
    const match = /^(cputype|cpusubtype|offset|size|align)\s+(.+)$/u.exec(line);
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
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const alignment = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const exponent = /2\^(\d+)/u.exec(value)?.[1];
  if (exponent !== undefined) return 2 ** Number.parseInt(exponent, 10);
  return integer(value);
};
