import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { isCdpCommand } from "./CdpCommands.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Literal names of CDP commands that have no result schema yet, per source
 * file. A command registered in CdpCommands.ts no longer counts. This list may
 * only shrink: migrate a file's commands, then lower or delete its entry.
 * Dynamic names such as `${domain}.enable` are not counted.
 */
const UNTYPED_CDP_COMMAND_BASELINE = JSON.parse(
  readFileSync(
    new URL("./CdpCommands.untyped-baseline.json", import.meta.url),
    "utf8",
  ),
) as Record<string, Record<string, number>>;

const protocolCommands = (): ReadonlySet<string> => {
  const protocol = readFileSync(
    join(root, "node_modules/playwright-core/types/protocol.d.ts"),
    "utf8",
  );
  const start = protocol.indexOf("export interface CommandParameters {");
  const end = protocol.indexOf("export interface CommandReturnValues {");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return new Set(
    [
      ...protocol
        .slice(start, end)
        .matchAll(/^\s+"([A-Za-z]+\.[A-Za-z]+)":/gmu),
    ].map((match) => match[1]!),
  );
};

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts") &&
      !/\.(?:test|spec|fixture)\.ts$/u.test(entry.name)
      ? [path]
      : [];
  });

const untypedCommands = (
  text: string,
  commands: ReadonlySet<string>,
): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const [, name] of text.matchAll(
    /["'`]([A-Z][A-Za-z]*\.[a-z][A-Za-z]*)["'`]/gu,
  )) {
    if (name === undefined || !commands.has(name) || isCdpCommand(name))
      continue;
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
};

it("distinguishes replacement untyped commands even when the total is unchanged", () => {
  const commands = protocolCommands();
  expect(untypedCommands('send("Runtime.enable")', commands)).not.toEqual(
    untypedCommands('send("Debugger.enable")', commands),
  );
});

it("sends no new CDP command without a registered result schema", () => {
  const commands = protocolCommands();
  expect(commands.size).toBeGreaterThan(500);
  const counts: Record<string, Record<string, number>> = {};
  for (const path of sourceFiles(join(root, "src"))) {
    const text = readFileSync(path, "utf8");
    const found = untypedCommands(text, commands);
    if (Object.keys(found).length > 0)
      counts[relative(root, path).split(sep).join("/")] = found;
  }
  const sorted = Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
  // A new name or increase means a new untyped command: register its result schema in
  // CdpCommands.ts instead. A decrease means the baseline must be lowered.
  expect(sorted).toEqual(UNTYPED_CDP_COMMAND_BASELINE);
});
