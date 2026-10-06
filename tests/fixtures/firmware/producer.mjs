import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
const mode = process.env.REA_FIRMWARE_FIXTURE_MODE;
const engine = process.env.REA_FIRMWARE_FIXTURE_ENGINE;
if (args.includes("--version")) {
  console.log(
    mode === "version"
      ? "unsupported"
      : engine === "binwalk"
        ? "binwalk 3.1.0"
        : "26.6.4",
  );
} else if (mode === "stall") {
  setInterval(() => {}, 1000);
} else {
  const input = args.at(-1);
  const bytes = await readFile(input);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const reportPath =
    args[args.indexOf(engine === "binwalk" ? "--log" : "--report") + 1];
  if (engine === "binwalk") {
    await writeFile(
      reportPath,
      JSON.stringify([
        {
          Analysis: {
            file_path: mode === "wrong-input" ? "/tmp/another.bin" : input,
            file_map: [
              {
                id: "hit",
                offset: 2,
                size: mode === "bounds" ? bytes.length : 4,
                name: "gzip",
                confidence: 250,
                description: "fixture signature",
                always_display: false,
                extraction_declined: false,
              },
            ],
            extractions: {},
          },
        },
      ]),
    );
  } else {
    const output = args[args.indexOf("--extract-dir") + 1];
    await mkdir(output, { recursive: true });
    const child =
      mode === "reserved-name"
        ? join(output, "$input")
        : join(output, "rootfs", "config");
    await mkdir(join(output, "rootfs"));
    const content = Buffer.from("firmware=true\n");
    if (mode !== "missing-file")
      await writeFile(child, mode === "budget" ? Buffer.alloc(10000) : content);
    if (mode === "link") await symlink("/etc/passwd", join(output, "escape"));
    const childHash = createHash("sha256").update(content).digest("hex");
    const depth =
      mode === "depth" ? Number(args[args.indexOf("--depth") + 1]) : 1;
    const stat = (path, size) => ({
      __typename__: "StatReport",
      path,
      size,
      is_file: true,
      is_dir: false,
      is_link: false,
      link_target: null,
    });
    const task = (path, level, id) => ({
      path,
      depth: level,
      blob_id: id,
      is_multi_file: false,
    });
    const hash = (value) => ({ __typename__: "HashReport", sha256: value });
    const childTask = task(child, depth, "gzip-id");
    const records = [
      {
        task: childTask,
        reports: [
          stat(child, content.length),
          ...(mode === "depth"
            ? []
            : [hash(mode === "hash" ? "a".repeat(64) : childHash)]),
        ],
        subtasks: [],
      },
      {
        task: task(input, 0, ""),
        reports: [
          stat(input, bytes.length),
          hash(sha256),
          {
            __typename__: "ChunkReport",
            id: "gzip-id",
            start_offset: 0,
            end_offset: bytes.length,
            size: bytes.length,
            handler_name: "gzip",
            is_encrypted: false,
            extraction_reports:
              mode === "dependency"
                ? [
                    {
                      __typename__: "ExtractorDependencyNotFoundReport",
                      severity: "ERROR",
                      dependencies: ["sasquatch"],
                    },
                  ]
                : [],
          },
        ],
        subtasks: [childTask],
      },
    ];
    await writeFile(
      reportPath,
      mode === "malformed" ? "[" : JSON.stringify(records),
    );
    if (mode === "dependency") process.exitCode = 1;
  }
}
