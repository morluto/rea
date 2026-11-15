import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { cliCommandFor } from "../../src/cliCommandNames.js";
import {
  CAPABILITY_DECLARATIONS,
  type CapabilityDeclaration,
} from "../../src/composition/capabilityDeclarations.js";
import { TOOL_CONTRACT_GROUPS } from "../../src/contracts/toolContracts.js";
import { projectForTest } from "../../scripts/lib/test-projects.mjs";
import { PROVIDER_CAPABILITY_CONFORMANCE } from "./providerCapabilityCases.js";

/** Test projects that run REA through its public CLI or MCP workflows. */
const PUBLIC_WORKFLOW_PROJECTS = new Set([
  "acceptance",
  "cli-boundary",
  "mcp-boundary",
]);

const repositoryFile = (path: string): string | undefined => {
  try {
    return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  } catch {
    return undefined;
  }
};

/** The operations and provider ids one declaration binds. */
const declaredSurface = (declaration: CapabilityDeclaration) => {
  const operations = new Set<string>();
  const providers = new Set<string>();
  for (const { identity, operations: selection } of declaration.providers) {
    providers.add(identity.id);
    const names =
      "group" in selection
        ? TOOL_CONTRACT_GROUPS[selection.group].map(({ name }) => name)
        : selection;
    for (const name of names) operations.add(name);
  }
  return { operations, providers };
};

/** A case names an operation as MCP or CLI callers spell it, or a provider id. */
const namesDeclaredSurface = (
  text: string,
  { operations, providers }: ReturnType<typeof declaredSurface>,
): boolean =>
  [...operations].some(
    (operation) =>
      text.includes(`"${operation}"`) ||
      text.includes(`"${cliCommandFor(operation)}"`),
  ) || [...providers].some((id) => text.includes(`"${id}"`));

const declarations = Object.entries(CAPABILITY_DECLARATIONS) as [
  keyof typeof CAPABILITY_DECLARATIONS,
  CapabilityDeclaration,
][];
const declared = declarations.filter(
  ([, declaration]) => declaration.providers.length > 0,
);

describe("provider capability conformance", () => {
  it("iterates every declared provider capability", () => {
    expect(declared.length).toBeGreaterThan(0);
    const missing = declared
      .map(([key]) => key)
      .filter((key) => PROVIDER_CAPABILITY_CONFORMANCE[key] === undefined);
    expect(missing, "declare a conformance case or an exemption").toEqual([]);
  });

  it("lists no capability that the declarations do not bind to a provider", () => {
    const bound = new Set<string>(declared.map(([key]) => key));
    expect(
      Object.keys(PROVIDER_CAPABILITY_CONFORMANCE).filter(
        (key) => !bound.has(key),
      ),
    ).toEqual([]);
  });

  it.each(declared)(
    "%s has a case that exercises its operations, or a reasoned exemption",
    (key, declaration) => {
      const entry = PROVIDER_CAPABILITY_CONFORMANCE[key];
      if (entry === undefined) throw new Error(`No conformance entry: ${key}`);
      if ("exempt" in entry) {
        expect(entry.exempt.trim()).not.toBe("");
        return;
      }
      const surface = declaredSurface(declaration);
      for (const path of entry.cases) {
        expect(
          PUBLIC_WORKFLOW_PROJECTS.has(projectForTest(path).name),
          `${path} runs a public CLI or MCP workflow`,
        ).toBe(true);
        const text = repositoryFile(path);
        expect(text, `${path} exists`).toBeDefined();
        expect(
          namesDeclaredSurface(text ?? "", surface),
          `${path} names an operation or provider of ${key}`,
        ).toBe(true);
      }
    },
  );
});
