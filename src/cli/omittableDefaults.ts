import { z } from "zod";

import type { CliInstance } from "./types.js";
import { cliCommands } from "./commandRegistry.js";

type CommandInputs = Partial<Record<(typeof INPUT_GROUPS)[number], unknown>>;

const INPUT_GROUPS = ["args", "options"] as const;

/**
 * Advertise parser-filled defaults as omittable CLI inputs.
 *
 * The CLI derives `--schema`, the `--llms` manifests, and help synopses from
 * Zod's output view, where a defaulted field always has a value and is
 * therefore listed as required. Callers may omit such a field, so each one is
 * wrapped as optional while its default, constraints, metadata, and parsed
 * value stay unchanged.
 */
export const presentOmittableDefaults = (cli: CliInstance): void => {
  for (const { definition } of cliCommands(cli)) presentInputs(definition);
};

const presentInputs = (command: CommandInputs): void => {
  for (const group of INPUT_GROUPS) {
    const schema = command[group];
    if (schema instanceof z.ZodObject)
      command[group] = withOmittableDefaults(schema);
  }
};

const withOmittableDefaults = (schema: z.ZodObject): z.ZodObject => {
  const omittable = Object.entries(schema.shape).filter(([, field]) =>
    fillsOmission(field),
  );
  if (omittable.length === 0) return schema;
  const metadata = schema.meta();
  const result = schema.safeExtend(
    Object.fromEntries(
      omittable.map(([key, field]) => [key, optionalWithMetadata(field)]),
    ),
  );
  return metadata === undefined ? result : result.meta(metadata);
};

/** Let the object parser decide omission; the CLI advertises required outputs. */
const fillsOmission = (field: z.ZodType): boolean =>
  field._zod.optout === undefined &&
  z.object({ value: field }).safeParse({}).success;

const optionalWithMetadata = (field: z.ZodType): z.ZodType => {
  const metadata = field.meta();
  return metadata === undefined
    ? field.optional()
    : field.optional().meta(metadata);
};
