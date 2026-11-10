import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { stateDirectories } from "./ApplicationStateDirectories.js";

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "stateDirectories existence at start",
  () => {
    it("leaves existence unknown when a parent folder denies the check", async () => {
      const root = await createTestTempDirectory("desktop-state-");
      const home = join(root, "home");
      const blocked = join(home, ".config");
      const state = join(blocked, "notes");
      await mkdir(state, { recursive: true });
      await chmod(blocked, 0o000);
      try {
        const entries = await stateDirectories(
          ["notes"],
          { environment: {}, home },
          [],
        );

        expect(entries).toContainEqual({ path: state, exists_at_start: null });
      } finally {
        await chmod(blocked, 0o755);
      }
    });

    it("still reports a missing folder as absent and a present one as present", async () => {
      const root = await createTestTempDirectory("desktop-state-");
      const home = join(root, "home");
      const present = join(home, ".config/notes");
      await mkdir(present, { recursive: true });

      const entries = await stateDirectories(
        ["notes"],
        { environment: {}, home },
        [],
      );

      expect(entries).toContainEqual({ path: present, exists_at_start: true });
      expect(entries).toContainEqual({
        path: join(home, ".local/share/notes"),
        exists_at_start: false,
      });
    });
  },
);
