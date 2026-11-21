import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withCommands } from "../command-scope.mjs";
import { acquireFixtureLease } from "./lease.mjs";

test("separate verifier processes share admission and release the same lease", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rea-ui-lease-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = {
    directory,
    serial: "emulator-5554",
    packageName: "com.rea.ui.probe",
    output: "/first",
  };
  const lease = await acquireFixtureLease(input);
  t.after(() => lease.release());
  const code = `import {acquireFixtureLease} from ${JSON.stringify(new URL("./lease.mjs", import.meta.url).href)};
    const lease = await acquireFixtureLease(${JSON.stringify({ ...input, output: "/second" })});
    await lease.release();`;
  await assert.rejects(
    withCommands((run) =>
      run(process.execPath, ["--input-type=module", "-e", code]),
    ),
    (error) =>
      error.snapshot.stderr.text.includes("Fixture lease is unavailable"),
  );
  assert.deepEqual(
    JSON.parse(await readFile(lease.path, "utf8")),
    lease.record,
  );
  await lease.release();
  await withCommands((run) =>
    run(process.execPath, ["--input-type=module", "-e", code]),
  );
});

test("lease cleanup refuses a replaced pathname without removing another owner", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rea-ui-lease-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = {
    directory,
    serial: "emulator-5554",
    packageName: "com.rea.ui.probe",
    output: "/first",
  };
  const first = await acquireFixtureLease(input);
  await rename(first.path, `${first.path}.saved`);
  const second = await acquireFixtureLease({ ...input, output: "/second" });
  try {
    await assert.rejects(first.release(), /no longer identifies/u);
    assert.deepEqual(
      JSON.parse(await readFile(second.path, "utf8")),
      second.record,
    );
  } finally {
    await second.release();
    await rename(`${first.path}.saved`, first.path);
    await first.release();
  }
});
