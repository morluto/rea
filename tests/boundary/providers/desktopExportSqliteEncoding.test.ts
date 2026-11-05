import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  PYTHON_HELPERS,
  PYTHON_IMPORTS,
} from "../../../src/domain/desktop/appExportPython.js";
import { PYTHON_TASK_EVALUATOR } from "../../../src/domain/desktop/appTaskPython.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each([
  ["UTF-8", "efbfbd", "80"],
  ["UTF-16le", "fdff", "00d8"],
  ["UTF-16be", "fffd", "d800"],
] as const)(
  "retains %s text bytes in exported SQLite views and task checks",
  async (encoding, hex, malformed) => {
    const root = await createTestTempDirectory("rea-export-sqlite-encoding-");
    const imports = PYTHON_IMPORTS.split("\n")
      .filter((line) => !line.includes("agentenv_protocol"))
      .join("\n");
    const program = `${imports}${PYTHON_HELPERS}${PYTHON_TASK_EVALUATOR}
path = Path(sys.argv[1])
with sqlite3.connect(path) as db:
    db.execute("PRAGMA encoding=" + repr(sys.argv[2]))
    db.execute('CREATE TABLE items(id INTEGER PRIMARY KEY, "body" TEXT, normal TEXT, raw BLOB, amount INTEGER, fraction REAL, missing)')
    db.execute('INSERT INTO items VALUES(1,?,?,?,?,?,NULL)', ("\ufffd", "emoji 😀\ufeff", b"t00", 9007199254740993, 2.5))
    db.execute("INSERT INTO items(id, body) VALUES(2,CAST(X'" + sys.argv[3] + "' AS TEXT))")
    native = db.execute('SELECT hex(CAST(body AS BLOB)) FROM items ORDER BY id').fetchall()
before = path.read_bytes()
entry = _sqlite(path)
checks = [{"id": "body-matches", "kind": "row_present", "file": "items.db", "table": "items", "where": {"id": 1, "body": {"text": "\ufffd", "bytes_hex": native[0][0].lower()}}}]
print(json.dumps({"entry": entry, "native": native, "verdicts": evaluate(checks, {"items.db": entry}), "unchanged": before == path.read_bytes()}))
`;
    const result = JSON.parse(
      execFileSync(
        "python3",
        [
          "-I",
          "-B",
          "-c",
          program,
          join(root, "items.db"),
          encoding,
          malformed,
        ],
        { encoding: "utf8" },
      ),
    );
    expect(result.native).toEqual([
      [hex.toUpperCase()],
      [malformed.toUpperCase()],
    ]);
    expect(result.entry.view.tables.items.rows).toEqual([
      [
        1,
        { text: "\ufffd", bytes_hex: hex },
        "emoji \u{1f600}\ufeff",
        { blob_hex: "743030" },
        { integer: "9007199254740993" },
        2.5,
        null,
      ],
      [
        2,
        { text: "\ufffd", bytes_hex: malformed },
        null,
        null,
        null,
        null,
        null,
      ],
    ]);
    expect(result.verdicts).toMatchObject([
      { id: "body-matches", result: true },
    ]);
    expect(result.unchanged).toBe(true);
  },
);
