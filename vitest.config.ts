import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    retry: 2,
    reporters: ["default", "verbose"],
    coverage: {
      enabled: true,
      provider: "v8",
      reportsDirectory: join(
        tmpdir(),
        `rea-vitest-coverage-${String(process.pid)}`,
      ),
      include: ["src/**"],
      thresholds: {
        statements: 65,
        branches: 60,
        functions: 60,
        lines: 68,
      },
      reporter: ["text", "text-summary"],
    },
  },
});
