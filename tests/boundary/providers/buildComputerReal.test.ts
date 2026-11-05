import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { DesktopBuildComputers } from "../../../src/application/desktop/DesktopBuildComputers.js";

const execute = promisify(execFile);

/**
 * Opt-in: starts a real computer with agentenv and Docker. Set
 * REA_BUILD_COMPUTER_REAL=1 with absolute REA_AGENT_ENV_COMMAND and
 * REA_DOCKER_COMMAND, and REA_BUILD_COMPUTER_REA_ARCHIVE naming a packed REA
 * build; run on a native amd64 or arm64 Linux host.
 */
describe.skipIf(process.env.REA_BUILD_COMPUTER_REAL !== "1")(
  "real agentenv build computer",
  () => {
    it("builds Mousepad with REA inside, drives it, records it and leaves no container", async () => {
      const computers = new DesktopBuildComputers(process.env);
      const signal = new AbortController().signal;
      const started = await computers.start(
        {
          source: {
            kind: "request",
            desktop_entry: "org.xfce.mousepad",
            window_class: "Mousepad",
            install: { kind: "archive", package: "mousepad" },
          },
        },
        signal,
      );
      if (!started.ok) throw started.error;
      const { computer_id: id, sandbox_id: sandbox } = started.value.value;
      try {
        expect(started.value.content).toContainEqual(
          expect.objectContaining({ type: "image", mimeType: "image/png" }),
        );
        const session = computers.session(id);
        if (session === undefined) throw new Error("no session");
        const recording = await session.startRecording(`rea-real:${id}`);
        const typed = await computers.act(
          { computer_id: id, action: "key", keys: ["ctrl+Escape"] },
          signal,
        );
        expect(typed.ok, JSON.stringify(typed)).toBe(true);
        const manifest = await session.endRecording(recording.recording_id);
        const segments = await session.recordingSegments(manifest);
        expect(segments.length).toBeGreaterThan(0);
      } finally {
        const closed = await computers.close(id);
        expect(closed.ok, JSON.stringify(closed)).toBe(true);
      }
      const { stdout } = await execute(process.env.REA_DOCKER_COMMAND ?? "", [
        "ps",
        "-aq",
        "--filter",
        `label=agentenv.sandbox=${sandbox}`,
      ]);
      expect(stdout.trim()).toBe("");
    }, 1_800_000);
  },
);
