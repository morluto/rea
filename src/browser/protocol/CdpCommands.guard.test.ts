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
const UNTYPED_CDP_COMMAND_BASELINE: Readonly<Record<string, number>> = {
  "src/browser/CdpCaptureStorage.ts": 4,
  "src/browser/CdpCaptureStorageFingerprints.ts": 5,
  "src/browser/CdpElectronInspection.ts": 1,
  "src/browser/CdpElectronWorkers.ts": 1,
  "src/browser/CdpEndpoint.ts": 2,
  "src/browser/CdpObservationSession.ts": 1,
  "src/browser/CdpPageCapture.ts": 5,
  "src/browser/CdpPageCaptureWorkers.ts": 1,
  "src/browser/CdpScreenshot.ts": 2,
  "src/browser/CdpWebMcpDiscovery.ts": 1,
  "src/browser/PlaywrightScenarioBrowser.ts": 13,
  "src/browser/PlaywrightScenarioServiceWorkers.ts": 1,
  "src/browser/PlaywrightScenarioStorage.ts": 1,
  "src/browser/execution/CdpEventListeners.ts": 4,
  "src/browser/execution/CdpListenerSelector.ts": 2,
};

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

it("sends no new CDP command without a registered result schema", () => {
  const commands = protocolCommands();
  expect(commands.size).toBeGreaterThan(500);
  const counts: Record<string, number> = {};
  for (const path of sourceFiles(join(root, "src"))) {
    const text = readFileSync(path, "utf8");
    for (const [, name] of text.matchAll(
      /["'`]([A-Z][A-Za-z]*\.[a-z][A-Za-z]*)["'`]/gu,
    )) {
      if (name === undefined || !commands.has(name) || isCdpCommand(name))
        continue;
      const file = relative(root, path).split(sep).join("/");
      counts[file] = (counts[file] ?? 0) + 1;
    }
  }
  const sorted = Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
  // An increase means a new untyped command: register its result schema in
  // CdpCommands.ts instead. A decrease means the baseline must be lowered.
  expect(sorted).toEqual(UNTYPED_CDP_COMMAND_BASELINE);
});
