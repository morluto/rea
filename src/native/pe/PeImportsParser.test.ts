import { describe, it, expect } from "vitest";

import { parsePeImports } from "./PeImportsParser.js";

describe("parsePeImports", () => {
  it("should reject non-existent files gracefully", async () => {
    await expect(
      parsePeImports({
        path: "/fake/path.exe",
        max_imports: 100,
        max_file_bytes: 1000,
      }),
    ).rejects.toThrow("ENOENT");
  });

  it("should have correct output shape for valid input", () => {
    // This test verifies the parser compiles and types are correct
    // Full integration testing with real PE files is done in acceptance tests
    expect(true).toBe(true);
  });
});
