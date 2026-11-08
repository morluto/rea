import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("Knip configuration", () => {
  it("fails on unresolved imports while allowing only build-only worker aliases", async () => {
    const config = JSON.parse(
      await readFile(`${repositoryRoot}/knip.json`, "utf8"),
    ) as {
      rules?: { unresolved?: string };
      ignoreUnresolved?: string[];
    };

    expect(config.rules?.unresolved).toBe("error");
    expect(config.ignoreUnresolved).toEqual([
      "^#web-bundle-analysis-worker$",
      "^#javascript-analysis-worker$",
    ]);
  });
});
