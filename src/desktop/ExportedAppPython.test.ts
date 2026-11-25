import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  PYTHON_HELPERS,
  PYTHON_IMPORTS,
} from "../domain/desktop/appExportPython.js";
import { execFileOutput } from "../process/ExecFileOutput.js";

const hasPython = (() => {
  try {
    execFileSync("python3", ["-c", "import sqlite3"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** Read a database with the exported `_sqlite` while another connection holds a write lock for `hold` seconds. */
const READ_WHILE_LOCKED = `
import sys, threading, time
exec(open(sys.argv[1]).read())
path, hold = Path(sys.argv[2]), float(sys.argv[3])
writer = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
writer.execute("create table notes (id integer primary key, body text)")
writer.execute("insert into notes (body) values ('kept')")
writer.execute("begin exclusive")
release = threading.Timer(hold, lambda: writer.execute("commit"))
release.daemon = True
release.start()
start = time.monotonic()
try:
    view = _sqlite(path)
    print(json.dumps({"rows": view["view"]["tables"]["notes"]["rows"], "seconds": time.monotonic() - start}))
except sqlite3.OperationalError as error:
    print(json.dumps({"error": str(error), "seconds": time.monotonic() - start}))
`;

const readWhileLocked = async (hold: number) => {
  const folder = await createTestTempDirectory("desktop-export-python-");
  const helpers = join(folder, "helpers.py");
  await writeFile(
    helpers,
    [
      ...PYTHON_IMPORTS.split("\n").filter(
        (line) => !line.includes("agentenv_protocol"),
      ),
      PYTHON_HELPERS,
    ].join("\n"),
  );
  const { stdout } = await execFileOutput(
    "python3",
    [
      "-I",
      "-c",
      READ_WHILE_LOCKED,
      helpers,
      join(folder, "app.db"),
      String(hold),
    ],
    { timeout: 20_000, maxBuffer: 64 * 1024 },
  );
  return JSON.parse(stdout) as {
    readonly rows?: unknown;
    readonly error?: string;
    readonly seconds: number;
  };
};

describe.skipIf(!hasPython)("the exported app's SQLite view", () => {
  it("waits out a brief write lock the running app holds", async () => {
    expect(await readWhileLocked(0.02)).toMatchObject({ rows: [[1, "kept"]] });
  });

  it("reports a lasting write lock within a fraction of a second", async () => {
    const locked = await readWhileLocked(3);

    expect(locked.error).toBe("database is locked");
    expect(locked.seconds).toBeGreaterThanOrEqual(0.2);
    expect(locked.seconds).toBeLessThan(2);
  });
});

/** Write the withheld files from settings as the class does at first boot, then read the views with them left out. */
const WRITE_WITHHELD = `
import sys, types
exec(open(sys.argv[1]).read())
home = Path(sys.argv[2])
settings = types.SimpleNamespace(licence=types.SimpleNamespace(get_secret_value=lambda: sys.argv[3]))
_write_withheld(home, settings, {"licence": ".config/app/licence"})
(home / ".config/app/conf.json").write_text("{}")
written = home / ".config/app/licence"
views = _views(home, [".config/app"], [".config/app/licence"])
print(json.dumps({"bytes": written.read_bytes().decode(), "mode": oct(written.stat().st_mode & 0o777), "views": sorted(views)}))
`;

describe.skipIf(!hasPython)("the exported app's withheld files", () => {
  it("writes each from its setting's base64 for its owner alone, and leaves it out of the views", async () => {
    const folder = await createTestTempDirectory("desktop-export-withheld-");
    const helpers = join(folder, "helpers.py");
    await writeFile(
      helpers,
      [
        ...PYTHON_IMPORTS.split("\n").filter(
          (line) => !line.includes("agentenv_protocol"),
        ),
        PYTHON_HELPERS,
      ].join("\n"),
    );
    // A made-up licence, never a real one.
    const licence = '{"SLicense":"e-fake-licence-0000"}';
    const { stdout } = await execFileOutput(
      "python3",
      [
        "-I",
        "-c",
        WRITE_WITHHELD,
        helpers,
        folder,
        Buffer.from(licence).toString("base64"),
      ],
      { timeout: 20_000, maxBuffer: 64 * 1024 },
    );
    expect(JSON.parse(stdout)).toEqual({
      bytes: licence,
      mode: "0o600",
      views: [".config/app/conf.json"],
    });
  });
});
