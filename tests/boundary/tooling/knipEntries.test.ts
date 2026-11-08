import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("Knip standalone verifier entries", () => {
  it("keeps every standalone Ghidra verifier reachable by the static gate", async () => {
    const config = JSON.parse(
      await readFile(`${repositoryRoot}/knip.json`, "utf8"),
    ) as { entry?: unknown };
    const entries = new Set(
      Array.isArray(config.entry)
        ? config.entry.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [],
    );

    for (const verifier of [
      "scripts/verify-real-ghidra-noreturn.mjs",
      "scripts/verify-real-ghidra-decompiler-failure.mjs",
      "scripts/verify-real-ghidra-decompile-timeout.mjs",
      "scripts/verify-real-ghidra-function-bundle.mjs",
    ]) {
      expect(entries.has(verifier), verifier).toBe(true);
    }
  });
});
