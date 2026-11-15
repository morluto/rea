import { createHash } from "node:crypto";

// A reviewable summary of what the packaged server advertises, recorded as one
// file per tool. A change that touches many tools' schemas at once, such as a
// pattern added to a shared path schema (#10830), still shows up in review as
// one aggregated line per pattern, while a PR that adds a tool adds only its
// own file and does not conflict with other tool PRs (#11189).

const SHOWN_NAMES = 8;
const KINDS = ["input", "output"];

const sorted = (record) =>
  Object.fromEntries(
    Object.entries(record).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );

/**
 * Summarize listings from every profile, per tool: a digest of each schema
 * per input or output profile, and the patterns each schema kind advertises.
 */
export const summarizeAdvertisedCatalogs = (
  catalogs,
  advertisedSchemaPatterns,
) => {
  const tools = new Map();
  const entry = (name) => {
    if (!tools.has(name))
      tools.set(name, {
        schemas: {},
        patterns: Object.fromEntries(KINDS.map((kind) => [kind, new Set()])),
      });
    return tools.get(name);
  };
  for (const { profile, tools: listed } of catalogs)
    for (const tool of listed)
      for (const kind of KINDS) {
        const schema = tool[`${kind}Schema`];
        if (schema === undefined) continue;
        const record = entry(tool.name);
        record.schemas[`${kind} ${profile[kind]}`] = createHash("sha256")
          .update(JSON.stringify(schema))
          .digest("hex")
          .slice(0, 16);
        for (const { pattern } of advertisedSchemaPatterns(schema))
          record.patterns[kind].add(pattern);
      }
  return Object.fromEntries(
    [...tools]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, { schemas, patterns }]) => [
        name,
        {
          schemas: sorted(schemas),
          patterns: Object.fromEntries(
            KINDS.flatMap((kind) =>
              patterns[kind].size === 0
                ? []
                : [[kind, [...patterns[kind]].sort()]],
            ),
          ),
        },
      ]),
  );
};

/** The committed file name for one tool's summary. */
export const toolSummaryFile = (name) => `${name}.json`;

/** One tool's summary as committed: sorted, two-space JSON with a newline. */
export const serializeToolSummary = (summary) =>
  `${JSON.stringify(summary, null, 2)}\n`;

const names = (values) =>
  values.length > SHOWN_NAMES
    ? `${values.slice(0, SHOWN_NAMES).join(", ")} and ${String(values.length - SHOWN_NAMES)} more`
    : values.join(", ");

/** Each `<tool> <kind>` site that advertises each pattern, across tools. */
const patternSites = (tools) => {
  const sites = new Map();
  for (const [name, { patterns }] of Object.entries(tools))
    for (const [kind, listed] of Object.entries(patterns ?? {}))
      for (const pattern of listed) {
        if (!sites.has(pattern)) sites.set(pattern, new Set());
        sites.get(pattern).add(`${name} ${kind}`);
      }
  return sites;
};

/** Review lines for every difference between two per-tool summaries. */
export const describeSummaryChanges = (recorded, current) => {
  const lines = [];
  const before = patternSites(recorded);
  const after = patternSites(current);
  for (const pattern of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(pattern) ?? new Set();
    const is = after.get(pattern) ?? new Set();
    const gained = [...is].filter((site) => !was.has(site)).sort();
    const lost = [...was].filter((site) => !is.has(site)).sort();
    if (gained.length > 0)
      lines.push(
        `${String(gained.length)} tool schemas gained pattern /${pattern}/: ${names(gained)}`,
      );
    if (lost.length > 0)
      lines.push(
        `${String(lost.length)} tool schemas lost pattern /${pattern}/: ${names(lost)}`,
      );
  }
  const changed = new Map();
  for (const tool of new Set([
    ...Object.keys(recorded),
    ...Object.keys(current),
  ])) {
    const was = recorded[tool]?.schemas ?? {};
    const is = current[tool]?.schemas ?? {};
    for (const group of new Set([...Object.keys(was), ...Object.keys(is)]))
      if (was[group] !== is[group]) {
        if (!changed.has(group)) changed.set(group, []);
        changed.get(group).push(tool);
      }
  }
  for (const [group, changedTools] of changed)
    lines.push(
      `${String(changedTools.length)} tools changed their ${group} schema: ${names(changedTools.sort())}`,
    );
  return lines;
};
