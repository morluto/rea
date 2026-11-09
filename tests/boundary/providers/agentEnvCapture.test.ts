import { execFileSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("agentenv capture launch", () => {
  it("records an exit when the capture process never starts, so stop does not wait", async () => {
    const root = await createTestTempDirectory("agentenv-capture-");
    const bin = join(root, "bin");
    const work = join(root, "work");
    const capture = join(root, "capture");
    await mkdir(bin);
    await mkdir(work);
    await writeFile(join(bin, "rea"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "rea"), 0o755);
    const script = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("capture", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def boom(*_args, **_kwargs):
    raise OSError("cannot start")
module.subprocess.Popen = boom
module.start({"work": sys.argv[2], "capture": sys.argv[3], "desktop_entry": "notes.desktop"})
print(json.dumps({"exit": module._exit_code(sys.argv[3]), "control": os.path.exists(os.path.join(sys.argv[3], "control"))}))
`;
    const output = execFileSync(
      "python3",
      [
        "-I",
        "-B",
        "-c",
        script,
        fileURLToPath(
          new URL("../../../bridge/agentenv/capture.py", import.meta.url),
        ),
        work,
        capture,
      ],
      {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        encoding: "utf8",
      },
    );
    const lines = output.trim().split("\n");
    const recorded = JSON.parse(lines.at(-1) ?? "{}") as {
      exit: number | null;
      control: boolean;
    };

    expect(recorded.exit).toBe(1);
    expect(recorded.control).toBe(false);
  });
});
