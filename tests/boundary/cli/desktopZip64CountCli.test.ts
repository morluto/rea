import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import {
  HOME,
  capture,
  retained,
  writeCaptureFolder,
} from "../../../src/application/desktop/desktopCapture.fixture.js";
import { zipArchive } from "../../../src/domain/desktop/zipArchive.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { writeZip64CountArchive } from "../../fixtures/zip64CountArchive.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "exports a reader that honors a raised Zip64 listing policy",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-export-zip64-count-");
    const archive = join(root, "many.zip");
    writeZip64CountArchive(archive, 65536);
    const bytes = await readFile(archive);
    const seed = zipArchive([{ name: "seed.bin", data: "ab", method: 0 }]);
    const originalPath = `${HOME}/Documents/many.zip`;
    const base = capture();
    const folder = await writeCaptureFolder(
      {
        ...base,
        state: {
          ...base.state,
          checkpoints: base.state.checkpoints.map((checkpoint) => ({
            ...checkpoint,
            retained: [...checkpoint.retained, retained(originalPath, seed)],
          })),
        },
      },
      undefined,
      [seed],
    );
    const bundle = join(root, "bundle");
    const exported = await cli.run({
      arguments: [
        "export-desktop-application",
        folder,
        bundle,
        "--view-policy",
        '{"zip_entries":65536,"zip_entry_bytes":1}',
        "--json",
      ],
    });
    expect(exported.exitCode, exported.stdout).toBe(0);
    const module = await readFile(
      join(bundle, "envs/notes/notes_app.py"),
      "utf8",
    );
    // Run exactly the emitted reader, without requiring the AgentEnv framework.
    const helpers = module
      .split("@computer_app(")[0]!
      .split("\n")
      .filter((line) => !line.includes("from agentenv_protocol"))
      .join("\n");
    const script = join(root, "inspect.py");
    await writeFile(
      script,
      `${helpers}\nresult = _view(Path(json.load(sys.stdin)))
view = result.get("view")
print(json.dumps({"policy":MAX_ZIP_ENTRIES,"error":result.get("error"),"summary":None if view is None else {
    "count":len(view["entries"]),"total":view["entry_count"],"truncated":view["truncated"],
    "last":view["entries"][-1]}}))\n`,
    );
    const observed: unknown = JSON.parse(
      execFileSync(
        process.platform === "win32" ? "python" : "python3",
        ["-I", "-B", script],
        { input: JSON.stringify(archive), encoding: "utf8" },
      ),
    );
    expect(observed).toEqual({
      policy: 65536,
      error: null,
      summary: {
        count: 65536,
        total: 65536,
        truncated: false,
        last: expect.objectContaining({
          name: "entry-65535.bin",
          view_error: "larger than the 1 bytes an entry's view reads",
        }),
      },
    });
    expect((await readFile(archive)).equals(bytes)).toBe(true);
  },
);
