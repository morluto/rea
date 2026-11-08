import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { waitForTestPidFile } from "../../support/process/pidFile.js";

it("waits through a missing file and an empty file before accepting its PID", async () => {
  const directory = await createTestTempDirectory("rea-pid-file-");
  const path = join(directory, "pid");
  let settled = false;
  const reading = waitForTestPidFile(path, 1_000).finally(() => {
    settled = true;
  });
  const observed = reading.catch(() => undefined);
  try {
    await delay(30);
    expect(settled).toBe(false);
    const file = await open(path, "w");
    try {
      await delay(30);
      expect(settled).toBe(false);
      await file.writeFile(String(process.pid));
      await expect(reading).resolves.toBe(process.pid);
    } finally {
      await file.close();
    }
  } finally {
    await observed;
  }
});

it.each(["", "0", "-1", "1e3", "12x", "9007199254740992"])(
  "refuses a PID file containing %j when its deadline expires",
  async (text) => {
    const directory = await createTestTempDirectory("rea-invalid-pid-file-");
    const path = join(directory, "pid");
    await writeFile(path, text);
    await expect(waitForTestPidFile(path, 30)).rejects.toThrow(
      "did not publish a valid PID",
    );
  },
);
