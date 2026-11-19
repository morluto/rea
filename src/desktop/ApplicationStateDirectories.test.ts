import { chmod, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { desktopApplicationInventorySchema } from "../domain/desktop/desktopCapture.js";
import { stateDirectories } from "./ApplicationStateDirectories.js";

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "preserves unknown state-path existence when permission denies the probe",
  async () => {
    const home = await createTestTempDirectory("state-path-existence-");
    const sealed = join(home, "sealed");
    const denied = join(sealed, "notes");
    const present = join(home, ".notes");
    const absent = join(home, ".local/share/notes");
    await mkdir(denied, { recursive: true });
    await mkdir(present);
    await chmod(sealed, 0o000);
    try {
      await expect(lstat(denied)).rejects.toMatchObject({ code: "EACCES" });
      const directories = await stateDirectories(
        ["notes"],
        {
          home,
          environment: { XDG_CONFIG_HOME: sealed },
        },
        [],
      );
      const facts = new Map(directories.map((entry) => [entry.path, entry]));
      expect(facts.get(present)).toEqual({
        path: present,
        exists_at_start: true,
      });
      expect(facts.get(absent)).toEqual({
        path: absent,
        exists_at_start: false,
      });
      expect(facts.get(denied)).toMatchObject({
        path: denied,
        exists_at_start: null,
        existence_error: expect.stringContaining("EACCES"),
      });
      expect(
        desktopApplicationInventorySchema.shape.state_directories.parse(
          directories,
        ),
      ).toEqual(directories);
    } finally {
      await chmod(sealed, 0o700);
    }
  },
);
