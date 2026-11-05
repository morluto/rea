import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  APT_LOCATIONS,
  resolveAptLocations,
} from "./AptRepositoryInventory.js";
import { runHostQuery, type QueryRunner } from "./HostQuery.js";

describe.skipIf(
  process.platform !== "linux" || !existsSync("/usr/bin/apt-config"),
)("resolveAptLocations with apt-config", () => {
  it("reads the lists folder an APT_CONFIG file names, resolved under Dir::State", async () => {
    const root = await createTestTempDirectory("apt-config-");
    const config = join(root, "apt.conf");
    await writeFile(
      config,
      `Dir::State "${root}/state";\nDir::State::Lists "user lists";\n`,
    );
    const configured: QueryRunner = (command, argv, signal) =>
      runHostQuery("env", [`APT_CONFIG=${config}`, command, ...argv], signal);

    const locations = await resolveAptLocations(configured, undefined);

    expect(locations).toEqual({
      lists: `${root}/state/user lists/`,
      trustedParts: "/etc/apt/trusted.gpg.d/",
      trusted: "/etc/apt/trusted.gpg",
    });
    expect(
      await resolveAptLocations(
        (_command, argv, signal) =>
          runHostQuery("/missing/apt-config", argv, signal),
        undefined,
      ),
    ).toEqual(APT_LOCATIONS);
  });
});
