import { statSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CAPABILITY_DECLARATIONS } from "../../src/composition/capabilityDeclarations.js";
import { projectForTest } from "../../scripts/lib/test-projects.mjs";
import { PROVIDER_CAPABILITY_CONFORMANCE } from "./providerCapabilityCases.js";

/** Test projects that run REA through its public CLI or MCP workflows. */
const PUBLIC_WORKFLOW_PROJECTS = new Set([
  "acceptance",
  "cli-boundary",
  "mcp-boundary",
]);

const declared = (
  Object.keys(
    CAPABILITY_DECLARATIONS,
  ) as (keyof typeof CAPABILITY_DECLARATIONS)[]
).filter((key) => CAPABILITY_DECLARATIONS[key].providers.length > 0);

describe("provider capability conformance", () => {
  it("iterates every declared provider capability", () => {
    expect(declared.length).toBeGreaterThan(0);
    const missing = declared.filter(
      (key) => PROVIDER_CAPABILITY_CONFORMANCE[key] === undefined,
    );
    expect(missing, "declare a conformance case or an exemption").toEqual([]);
  });

  it("lists no capability that the declarations do not bind to a provider", () => {
    const bound = new Set<string>(declared);
    expect(
      Object.keys(PROVIDER_CAPABILITY_CONFORMANCE).filter(
        (key) => !bound.has(key),
      ),
    ).toEqual([]);
  });

  it.each(declared)(
    "%s names an existing public-workflow test or gives a reasoned exemption",
    (key) => {
      const entry = PROVIDER_CAPABILITY_CONFORMANCE[key];
      if (entry === undefined) throw new Error(`No conformance entry: ${key}`);
      if ("exempt" in entry) {
        expect(entry.exempt.trim()).not.toBe("");
        return;
      }
      for (const path of entry.cases) {
        expect(
          PUBLIC_WORKFLOW_PROJECTS.has(projectForTest(path).name),
          `${path} runs a public CLI or MCP workflow`,
        ).toBe(true);
        expect(
          statSync(new URL(`../../${path}`, import.meta.url), {
            throwIfNoEntry: false,
          })?.isFile(),
          `${path} exists as a test file`,
        ).toBe(true);
      }
    },
  );
});
