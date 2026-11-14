import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import {
  HOME,
  capture,
  change,
  checkpoint,
  retained,
  writeCaptureFolder,
} from "../../../src/application/desktop/desktopCapture.fixture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const FILE = "Documents/map.xml";

cliTest.for([
  { count: 1000, nested: true },
  { count: 130_000, nested: false },
  { count: 130_000, nested: true },
])(
  "describes a captured XML member count (count=$count, nested=$nested)",
  async ({ count, nested }, { cli }) => {
    const path = `${HOME}/${FILE}`;
    const xml = (members: number, title: string) => {
      const branches = "<branch/>".repeat(members);
      return `<map branchCount="${String(members)}" title="${title}">${nested ? `<branches>${branches}</branches>` : branches}</map>`;
    };
    const before = xml(count - 1, "Before");
    const after = xml(count, "After");
    const base = capture();
    const folder = await writeCaptureFolder(
      {
        ...base,
        session: {
          ...base.session,
          windows: base.session.windows.map((window) => ({
            ...window,
            titles: ["map.xml - Notes"],
          })),
        },
        state: {
          ...base.state,
          content_roots: [`${HOME}/Documents`],
          content_files: 2,
          content_bytes: before.length + after.length,
          checkpoints: [
            checkpoint("seed", "baseline", [], [retained(path, before)]),
            checkpoint(
              "end",
              "request",
              [change(path, { before, after })],
              [retained(path, after)],
            ),
          ],
        },
      },
      undefined,
      [before, after],
    );
    const captureBytes = await readFile(join(folder, "capture.json"), "utf8");
    const policy = { xml_nodes: count + 2 };
    const result = await cli.run({
      arguments: [
        "describe-desktop-application-task",
        folder,
        "--view-policy",
        JSON.stringify(policy),
        "--json",
      ],
    });

    expect(result.exitCode, result.stdout).toBe(0);
    const evidence = parseEvidence(result.json);
    expect(evidence).toMatchObject({
      operation: "describe_desktop_application_task",
      parameters: {
        capture_evidence_id: parseEvidence(JSON.parse(captureBytes))
          .evidence_id,
        view_policy: policy,
      },
      normalized_result: {
        checkpoints: { baseline: "seed", final: "end" },
        effective_view_policy: policy,
        files: [
          {
            file: FILE,
            change: { complete: true },
            baseline: { view_cut: true },
            final: { view_cut: true },
            values_cut: false,
            values: expect.arrayContaining([
              expect.objectContaining({
                pointer: "/root/attributes/branchCount",
                note: "upkeep",
              }),
            ]),
          },
        ],
        task: {
          checks: expect.arrayContaining([
            expect.objectContaining({
              pointer: "/root/attributes/title",
              value: "After",
            }),
          ]),
        },
      },
    });
    const counter = expect.objectContaining({
      pointer: "/root/attributes/branchCount",
    });
    expect(evidence.normalized_result).toMatchObject({
      task: { checks: expect.not.arrayContaining([counter]) },
      guards: expect.not.arrayContaining([counter]),
    });
    expect(await readFile(join(folder, "capture.json"), "utf8")).toBe(
      captureBytes,
    );
  },
);
