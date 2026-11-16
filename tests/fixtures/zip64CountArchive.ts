import { execFileSync } from "node:child_process";

/** Python's independent ZIP writer emits a genuine Zip64 tail above 65535 files. */
export const writeZip64CountArchive = (path: string, count: number): void => {
  execFileSync(process.platform === "win32" ? "python" : "python3", [
    "-I",
    "-B",
    "-c",
    `
import sys, zipfile
count = int(sys.argv[2])
with zipfile.ZipFile(sys.argv[1], "w", compression=zipfile.ZIP_STORED) as archive:
    for index in range(count):
        archive.writestr(f"entry-{index:05d}.bin", b"ab")
with zipfile.ZipFile(sys.argv[1]) as archive:
    assert len(archive.infolist()) == count
    assert archive.read(f"entry-{count - 1:05d}.bin") == b"ab"
`,
    path,
    String(count),
  ]);
};
