import { execFileSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ScreenJudgeProcess } from "./ScreenJudgeProcess.js";
import { waitFor } from "../../tests/support/testWait.js";

const check = { id: "x", kind: "screen_judge", question: "ready?" } as const;

it.skipIf(process.platform === "win32")(
  "returns the judge's answer for its screenshot",
  async () => {
    const folder = await createTestTempDirectory("screen-answer-");
    const python = execFileSync("which", ["python3"], {
      encoding: "utf8",
    }).trim();
    const runner = join(folder, "agent-env");
    const verifier = join(folder, "verify.py");
    await writeFile(runner, `#!${python}\n`);
    await chmod(runner, 0o700);
    await writeFile(
      verifier,
      'import json, sys\nprint(json.dumps({"id": "x", "result": open(sys.argv[3], "rb").read() == b"image", "description": "checked"}))\n',
    );
    const judge = new ScreenJudgeProcess({
      ...process.env,
      REA_AGENT_ENV_COMMAND: runner,
    });
    expect(
      await judge.judge(
        verifier,
        check,
        Buffer.from("image"),
        new AbortController().signal,
      ),
    ).toEqual({ id: "x", passed: true, description: "checked" });
    expect(await judge.close()).toMatchObject({ verified: true });
  },
);

it.skipIf(process.platform === "win32")(
  "stops the judge and a separate-session child before cancellation settles",
  async () => {
    const folder = await createTestTempDirectory("screen-owner-");
    const python = execFileSync("which", ["python3"], {
      encoding: "utf8",
    }).trim();
    const runner = join(folder, "agent-env");
    const verifier = join(folder, "verify.py");
    const marker = join(folder, "child.pid");
    await writeFile(runner, `#!${python}\n`);
    await chmod(runner, 0o700);
    await writeFile(
      verifier,
      `import subprocess, sys, time\np = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)\nopen(${JSON.stringify(marker)}, "w").write(str(p.pid))\ntime.sleep(60)\n`,
    );
    const judge = new ScreenJudgeProcess({
      ...process.env,
      REA_AGENT_ENV_COMMAND: runner,
    });
    const controller = new AbortController();
    const running = judge.judge(
      verifier,
      check,
      new Uint8Array([1]),
      controller.signal,
    );
    void running.catch(() => undefined);
    let pid = 0;
    try {
      await waitFor(async () => {
        pid = Number(await readFile(marker, "utf8"));
        expect(pid).toBeGreaterThan(0);
      });
      controller.abort(new Error("cancelled by caller"));
      await expect(running).rejects.toThrow();
      let state = "";
      try {
        state = execFileSync("ps", ["-p", String(pid), "-o", "stat="], {
          encoding: "utf8",
        }).trim();
      } catch {
        /* Process no longer exists. */
      }
      expect(state === "" || state.startsWith("Z")).toBe(true);
      expect(await judge.close()).toMatchObject({ verified: true });
    } finally {
      controller.abort(new Error("test cleanup"));
      await running.catch(() => undefined);
      expect(await judge.close()).toMatchObject({ verified: true });
    }
  },
);
