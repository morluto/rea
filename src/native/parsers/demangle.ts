import { z } from "zod";

const resultSchema = z.object({
  input: z.string(),
  output: z.string(),
  status: z.enum(["demangled", "unchanged", "invalid"]),
});

/** Preserve input ordering while parsing `swift-demangle --compact` lines. */
export const parseDemangledSymbols = (
  inputs: readonly string[],
  output: string,
) => {
  const lines = output.trimEnd().split(/\r?\n/u);
  if (lines.length !== inputs.length)
    throw new TypeError("swift-demangle output count does not match input");
  return inputs.map((input, index) => {
    const value = lines[index];
    if (value === undefined)
      throw new TypeError("swift-demangle omitted an output line");
    return resultSchema.parse({
      input,
      output: value,
      status:
        value === input
          ? input.startsWith("$s") || input.startsWith("_$s")
            ? "invalid"
            : "unchanged"
          : "demangled",
    });
  });
};
