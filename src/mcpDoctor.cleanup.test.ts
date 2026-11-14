import { resolve } from "node:path";

import { expect, it, vi } from "vitest";

const cleanupDenial = vi.hoisted(() => ({
  reason: undefined as string | undefined,
}));

// Keep real process-group cleanup, then report the selected denial so the
// doctor's late cleanup failure is observed without leaking the fixture.
vi.mock("./process/ProcessOwnership.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./process/ProcessOwnership.js")>();
  return {
    ...original,
    cleanupOwnedProcessGroup: async (
      ...parameters: Parameters<typeof original.cleanupOwnedProcessGroup>
    ) => {
      const released = await original.cleanupOwnedProcessGroup(...parameters);
      return cleanupDenial.reason === undefined
        ? released
        : { cleaned: false as const, reason: cleanupDenial.reason };
    },
  };
});

import { runProductionMcpDoctor } from "./mcpDoctor.js";

it("keeps the startup diagnostic and reports retained resources when cleanup fails", async () => {
  cleanupDenial.reason = "fixture process group remained alive";
  try {
    const result = await runProductionMcpDoctor({
      command: process.execPath,
      args: [resolve("tests/fixtures/mcpDoctorExit.mjs")],
      cwd: process.cwd(),
      environment: { ...process.env, REA_MCP_DOCTOR_DEADLINE_MS: "5000" },
    });

    expect(result).toMatchObject({
      healthy: false,
      checks: [
        { name: "transport", ok: false },
        {
          name: "cleanup",
          ok: false,
          detail: expect.stringMatching(
            /^MCP stdio cleanup failed: Provider mcp-doctor adapter failed during mcp_doctor \(fixture process group remained alive\); retained resources: [0-9a-f-]{36}$/u,
          ),
        },
      ],
      diagnostics: {
        stderr: "fixture MCP startup exit\n",
        stderr_truncated: false,
      },
    });
  } finally {
    cleanupDenial.reason = undefined;
  }
});
