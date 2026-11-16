import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { scanZipDirectory } from "./zipDirectory.js";
import { exportedPython } from "../../../tests/support/desktopExportPython.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { writeZip64CountArchive } from "../../../tests/fixtures/zip64CountArchive.js";
import {
  desktopViewPolicy,
  pythonDesktopViewPolicy,
} from "./desktopViewPolicy.js";

it.each([1000, 65535, 65536, 65537])(
  "keeps the selected ZIP listing count %i in the exported reader",
  async (keep) => {
    const root = await createTestTempDirectory("rea-zip64-view-count-");
    const archive = join(root, "many.zip");
    // An independent producer writes a genuine Zip64 archive, not a decoder-copy fixture.
    writeZip64CountArchive(archive, 65537);
    const bytes = await readFile(archive);
    // Exercise listing admission without inflating 65K individual payloads.
    // Every 2-byte member remains explicitly unread under the 1-byte budget.
    const policy = desktopViewPolicy({
      zip_entries: keep,
      zip_entry_bytes: 1,
    });
    const output: unknown = JSON.parse(
      exportedPython(
        `
${pythonDesktopViewPolicy(policy)}
result = _view(Path(json.load(sys.stdin)))
view = result.get("view")
print(json.dumps({"error":result.get("error"), "summary":None if view is None else {
    "listed":len(view["entries"]), "total":view["entry_count"], "truncated":view["truncated"],
    "first":view["entries"][0], "last":view["entries"][-1]}}))
`,
        archive,
      ),
    );
    const directory = scanZipDirectory(bytes, keep);
    expect(directory?.count).toBe(65537);
    expect(directory?.records).toHaveLength(keep);
    const expected = {
      listed: keep,
      total: 65537,
      truncated: keep < 65537,
      first: expect.objectContaining({
        name: "entry-00000.bin",
        view_error: "larger than the 1 bytes an entry's view reads",
      }),
      last: expect.objectContaining({
        name: `entry-${String(keep - 1).padStart(5, "0")}.bin`,
        view_error: "larger than the 1 bytes an entry's view reads",
      }),
    };
    expect(output).toEqual({ error: null, summary: expected });
    expect((await readFile(archive)).equals(bytes)).toBe(true);
  },
);

it.each([0xfffffffe, 0xffffffff, 0x100000000])(
  "keeps a wide directory offset in Zip64 without overflowing the classic end (%i)",
  (offset) => {
    const output: unknown = JSON.parse(
      exportedPython(
        `
offset = json.load(sys.stdin)
tail = _zip_directory_tail([], offset)
classic = struct.unpack("<4s4H2IH", tail[-22:])
wide = struct.unpack("<4sQ2H2I4Q", tail[:56])
locator = struct.unpack("<4sIQI", tail[56:76])
print(json.dumps({"classic_offset":classic[6], "wide_offset":wide[9], "locator_offset":locator[2],
                 "entry_count":wide[7], "directory_size":wide[8]}))
`,
        offset,
      ),
    );
    expect(output).toEqual({
      classic_offset: Math.min(offset, 0xffffffff),
      wide_offset: offset,
      locator_offset: offset,
      entry_count: 0,
      directory_size: 0,
    });
  },
);
