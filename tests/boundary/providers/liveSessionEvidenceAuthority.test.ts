import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * A live session observes an artifact that REA itself launched and drove, so its
 * evidence belongs to the controlled-replay authority. Letting these sites rely on
 * the createEvidence default silently degrades them to analyst-inference or, before
 * the default was bound to the subject, promoted them to shipped-artifact.
 */
const LIVE_SESSION_SOURCES = [
  "../../../src/gdb/GdbSessionManager.ts",
  "../../../src/rizin/RizinDebugSessionManager.ts",
  "../../../src/cutter/CutterBridgeService.ts",
] as const;

const CALL = "createEvidence(";

/** Return the balanced argument list starting at the opening parenthesis. */
const argumentList = (source: string, open: number): string => {
  let depth = 0;
  let quote: string | undefined;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== undefined) {
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return source.slice(open);
};

interface CallSite {
  readonly line: number;
  readonly arguments_: string;
}

const callSites = (source: string): CallSite[] => {
  const sites: CallSite[] = [];
  let index = source.indexOf(CALL);
  while (index >= 0) {
    const open = index + CALL.length - 1;
    sites.push({
      line: source.slice(0, index).split("\n").length,
      arguments_: argumentList(source, open),
    });
    index = source.indexOf(CALL, index + CALL.length);
  }
  return sites;
};

describe("live session evidence authority", () => {
  it.each(LIVE_SESSION_SOURCES)(
    "declares controlled-replay at every createEvidence site in %s",
    (relative) => {
      const source = readFileSync(new URL(relative, import.meta.url), "utf8");
      const sites = callSites(source);
      expect(sites.length).toBeGreaterThan(0);
      const undeclared = sites
        .filter(
          ({ arguments_ }) =>
            !/authority:\s*"controlled-replay"/u.test(arguments_),
        )
        .map(({ line }) => line);
      expect(undeclared).toEqual([]);
    },
  );
});
