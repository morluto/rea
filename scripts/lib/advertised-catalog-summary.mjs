import { createHash } from "node:crypto";

// A reviewable summary of what the packaged server advertises. A change that
// touches many tools' schemas at once, such as a pattern added to a shared
// path schema (#10830), shows up in review as one line per pattern instead of
// being buried in generated contracts.

const SHOWN_NAMES = 8;

const sorted = (record) =>
  Object.fromEntries(
    Object.entries(record).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );

/**
 * Summarize listings from every profile: each advertised pattern with the
 * tool schemas that advertise it, and a digest of each tool's schema per
 * input or output profile.
 */
export const summarizeAdvertisedCatalogs = (
  catalogs,
  advertisedSchemaPatterns,
) => {
  const patterns = new Map();
  const tools = new Map();
  const schemas = catalogs.flatMap(({ profile, tools: listed }) =>
    listed.flatMap((tool) =>
      [
        ["input", profile.input],
        ["output", profile.output],
      ].flatMap(([kind, selected]) => {
        const schema = tool[`${kind}Schema`];
        return schema === undefined
          ? []
          : [{ name: tool.name, kind, group: `${kind} ${selected}`, schema }];
      }),
    ),
  );
  for (const { name, kind, group, schema } of schemas) {
    for (const { pattern } of advertisedSchemaPatterns(schema)) {
      if (!patterns.has(pattern)) patterns.set(pattern, new Set());
      patterns.get(pattern).add(`${name} ${kind}`);
    }
    if (!tools.has(name)) tools.set(name, {});
    tools.get(name)[group] = createHash("sha256")
      .update(JSON.stringify(schema))
      .digest("hex")
      .slice(0, 16);
  }
  return {
    patterns: sorted(
      Object.fromEntries(
        [...patterns].map(([pattern, sites]) => [pattern, [...sites].sort()]),
      ),
    ),
    tools: sorted(
      Object.fromEntries(
        [...tools].map(([name, digests]) => [name, sorted(digests)]),
      ),
    ),
  };
};

const names = (values) =>
  values.length > SHOWN_NAMES
    ? `${values.slice(0, SHOWN_NAMES).join(", ")} and ${String(values.length - SHOWN_NAMES)} more`
    : values.join(", ");

/** Review lines for every difference between two summaries. */
export const describeSummaryChanges = (recorded, current) => {
  const lines = [];
  const recordedPatterns = recorded?.patterns ?? {};
  for (const pattern of new Set([
    ...Object.keys(recordedPatterns),
    ...Object.keys(current.patterns),
  ])) {
    const before = new Set(recordedPatterns[pattern] ?? []);
    const after = new Set(current.patterns[pattern] ?? []);
    const gained = [...after].filter((site) => !before.has(site));
    const lost = [...before].filter((site) => !after.has(site));
    if (gained.length > 0)
      lines.push(
        `${String(gained.length)} tool schemas gained pattern /${pattern}/: ${names(gained)}`,
      );
    if (lost.length > 0)
      lines.push(
        `${String(lost.length)} tool schemas lost pattern /${pattern}/: ${names(lost)}`,
      );
  }
  const recordedTools = recorded?.tools ?? {};
  const changed = new Map();
  for (const tool of new Set([
    ...Object.keys(recordedTools),
    ...Object.keys(current.tools),
  ]))
    for (const group of new Set([
      ...Object.keys(recordedTools[tool] ?? {}),
      ...Object.keys(current.tools[tool] ?? {}),
    ]))
      if (recordedTools[tool]?.[group] !== current.tools[tool]?.[group]) {
        if (!changed.has(group)) changed.set(group, []);
        changed.get(group).push(tool);
      }
  for (const [group, changedTools] of changed)
    lines.push(
      `${String(changedTools.length)} tools changed their ${group} schema: ${names(changedTools)}`,
    );
  return lines;
};
