import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    retry: 2,
    reporters: ["default", "verbose"],
    coverage: {
      enabled: true,
      provider: "v8",
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
