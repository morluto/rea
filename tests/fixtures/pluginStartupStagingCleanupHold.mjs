import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

/**
 * Hold the launcher inside retained-staging rmSync until the test releases it.
 * SIGTERM stays pending through the sync section and is delivered on the next
 * yield while observeStartupCleanupCancel is still installed.
 */
const remove = fs.rmSync;
const CLEANUP_OWNER = ".rea-plugin-cleanup-owner";
let held = false;
const wait = new Int32Array(new SharedArrayBuffer(4));

fs.rmSync = function (path, options) {
  const ready = process.env.REA_TEST_PLUGIN_STAGING_CLEANUP_READY_PATH;
  const release = process.env.REA_TEST_PLUGIN_STAGING_CLEANUP_RELEASE_PATH;
  if (
    !held &&
    ready !== undefined &&
    release !== undefined &&
    typeof path === "string" &&
    path.includes(".staging-") &&
    fs.existsSync(join(path, CLEANUP_OWNER))
  ) {
    held = true;
    fs.writeFileSync(ready, path, { mode: 0o600 });
    while (!fs.existsSync(release)) Atomics.wait(wait, 0, 0, 20);
  }
  return remove.call(this, path, options);
};
syncBuiltinESMExports();
