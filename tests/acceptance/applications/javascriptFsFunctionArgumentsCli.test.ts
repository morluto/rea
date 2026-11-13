import { expect } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import {
  analyzeJavaScriptDirectory,
  runNodeJsonControl,
} from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";
import { resolveJavaScriptSemanticEvidence } from "../../support/javascriptSemanticGraphFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "matches Node's fs function-valued argument rejection through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-fs-function-arguments-");
    await writeFixtureFiles(root, {
      input: "fixture",
      "entry.mjs": `
        import {open, openSync, closeSync} from "node:fs";
        import {open as openPromise} from "node:fs/promises";
        export const badSyncFlag = p => openSync(p, () => {});
        export const badSyncMode = p => openSync(p, "r", () => {});
        export const badSyncClassFlag = p => openSync(p, class {});
        export const badSyncClassMode = p => openSync(p, "r", class {});
        export const badPromiseFlag = p => openPromise(p, () => {});
        export const badPromiseClassFlag = p => openPromise(p, class {});
        export const badCallbackFlag = p => open(p, () => {}, () => {});
        export const missingCallback = p => open(p);
        export const missingShortCallback = p => open(p, "r");
        export const nonfunctionCallback = p => open(p, "r", 0o644, 17);
        export async function badPromiseMode(p) {
          const h = await openPromise(p, "r", () => {}); h.close();
        }
        export async function badPromiseClassMode(p) {
          const h = await openPromise(p, "r", class {}); h.close();
        }
        export const callbackOnly = p => new Promise((resolve, reject) =>
          open(p, (error, fd) => {
            if (error) reject(error);
            else { closeSync(fd); resolve("opened"); }
          }));
        export const callbackMode = p => new Promise((resolve, reject) =>
          open(p, "r", (error, fd) => {
            if (error) reject(error);
            else { closeSync(fd); resolve("opened"); }
          }));
        export const emptySpread = (p, ...args) => new Promise((resolve, reject) =>
          open(p, (error, fd) => {
            if (error) reject(error);
            else { closeSync(fd); resolve("opened"); }
          }, ...args));
      `,
      "control.mjs": `
        import * as fixture from "./entry.mjs";
        import {closeSync} from "node:fs";
        const observed = {};
        for (const [name, fn] of Object.entries(fixture)) {
          try {
            const value = await fn("input");
            if (typeof value === "number") closeSync(value);
            else if (typeof value?.close === "function") await value.close();
            observed[name] = value === "opened" ? value : "unexpected success";
          } catch (error) { observed[name] = error.code; }
        }
        console.log(JSON.stringify(observed));
      `,
    });
    expect(await runNodeJsonControl(root, "control.mjs")).toEqual({
      badSyncFlag: "ERR_INVALID_ARG_VALUE",
      badSyncMode: "ERR_INVALID_ARG_TYPE",
      badSyncClassFlag: "ERR_INVALID_ARG_VALUE",
      badSyncClassMode: "ERR_INVALID_ARG_TYPE",
      badPromiseFlag: "ERR_INVALID_ARG_VALUE",
      badPromiseClassFlag: "ERR_INVALID_ARG_VALUE",
      badCallbackFlag: "ERR_INVALID_ARG_VALUE",
      missingCallback: "ERR_INVALID_ARG_TYPE",
      missingShortCallback: "ERR_INVALID_ARG_TYPE",
      nonfunctionCallback: "ERR_INVALID_ARG_TYPE",
      badPromiseMode: "ERR_INVALID_ARG_TYPE",
      badPromiseClassMode: "ERR_INVALID_ARG_TYPE",
      callbackOnly: "opened",
      callbackMode: "opened",
      emptySpread: "opened",
    });

    const result = await analyzeJavaScriptDirectory(surface, cli, root, {
      sourcePaths: ["entry.mjs"],
    });
    const resources = result.semantic_graph.nodes.filter(
      ({ kind }) => kind === "resource",
    );
    expect(resources).toHaveLength(3);
    expect(resources.map(({ properties }) => properties.method)).toEqual([
      "open",
      "open",
      "open",
    ]);
    const source = await readFile(join(root, "entry.mjs"), "utf8");
    const expectedLines = source
      .split("\n")
      .flatMap((line, index) =>
        line.includes("open(p, (error, fd)") ||
        line.includes('open(p, "r", (error, fd)')
          ? [index + 1]
          : [],
      );
    const lines = resources.map(({ evidence: reference }) => {
      const evidence = resolveJavaScriptSemanticEvidence(
        result.semantic_graph,
        reference,
      );
      expect(evidence).toMatchObject({
        state: "observed",
        authority: "ast-static-analysis",
        artifact: {
          available: true,
          sha256: createHash("sha256").update(source).digest("hex"),
        },
        location: {
          available: true,
          value: { kind: "source-range", source: "entry.mjs" },
        },
      });
      const location = evidence.location;
      if (!location.available || location.value.kind !== "source-range")
        throw new Error("Expected a source range for the accepted open");
      return location.value.start.line;
    });
    expect(lines.sort((a, b) => a - b)).toEqual(expectedLines);
    expect(
      result.semantic_graph.relations.filter(
        ({ relation }) => relation === "acquires",
      ),
    ).toHaveLength(3);
    expect(
      result.semantic_graph.relations.filter(
        ({ relation }) => relation === "releases",
      ),
    ).toEqual([]);
  },
);
