import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { TestReverseEngineeringService } from "../../support/reverseEngineeringService.js";
import { Radare2SessionManager } from "../../../src/radare2/Radare2SessionManager.js";
import { parseRadare2Version } from "../../../src/radare2/Radare2Doctor.js";

const execFileAsync = promisify(execFile);

const probeRadare2 = async (): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("radare2", ["-version"], {
      timeout: 10_000,
    });
    const version = parseRadare2Version(stdout);
    if (version === null) return null;
    const [major = 0, minor = 0] = version.split(".").map(Number);
    if (major < 5 || (major === 5 && minor < 9)) return null;
    return version;
  } catch {
    return null;
  }
};

const version = await probeRadare2();
// CI sets REA_R2_REQUIRED=1 so the lane fails loudly instead of silently
// skipping when the engine probe cannot establish a usable version.
const required = process.env.REA_R2_REQUIRED === "1";
if (required && version === null)
  throw new Error(
    "REA_R2_REQUIRED is set but no usable radare2 >= 5.9 was found",
  );

describe.skipIf(version === null)(
  `real radare2 provider (${version ?? "unavailable"})`,
  () => {
    it("returns JSON binary information through the one-shot command", async () => {
      const service = new TestReverseEngineeringService();
      const result = await service.executeRadare2Command({
        path: process.execPath,
        command: "ij",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.provider.id).toBe("radare2");
      expect(result.value.raw_result).toMatchObject({
        exit_code: 0,
        completion_status: "complete",
      });
      expect(
        String((result.value.raw_result as { stdout?: string }).stdout),
      ).toContain('"core"');
    });

    it("answers session commands over the r2pipe2 protocol", async () => {
      const manager = new Radare2SessionManager();
      const started = await manager.start({ path: process.execPath });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const sessionId = started.value.session_id;
      try {
        const echo = await manager.execute(sessionId, "?e marker-probe");
        expect(echo.ok).toBe(true);
        if (echo.ok) {
          expect(echo.value.result.output).toContain("marker-probe");
          expect(echo.value.result.command_error).toBe(false);
        }
        const listed = await manager.execute(sessionId, "aflj");
        expect(listed.ok).toBe(true);
        if (listed.ok)
          expect(JSON.parse(listed.value.result.output)).toEqual(
            expect.any(Array),
          );
      } finally {
        const closed = await manager.close(sessionId);
        expect(closed.ok).toBe(true);
      }
    });
  },
);
