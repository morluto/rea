import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { exportDesktopApplication } from "./DesktopApplicationExport.js";
import {
  HOME,
  capture,
  checkpoint,
  readers,
  retained,
  writeCaptureFolder,
} from "./desktopCapture.fixture.js";

it("exports XML values with only the captured home changed, retaining reference and untouched-span semantics", async () => {
  const xml = `<root path="${HOME}/a\r\n b" referenced="${HOME}/a&#10;b" kept='a\r\nb'>${HOME}/a\r\nb&#13;c</root>`;
  const path = `${HOME}/.config/notes/settings.xml`;
  const base = capture();
  const captured = {
    ...base,
    state: {
      ...base.state,
      checkpoints: [
        checkpoint("baseline", "baseline", [], [retained(path, xml)]),
      ],
    },
  };
  const folder = await writeCaptureFolder(captured, undefined, [xml]);
  const source = await readFile(join(folder, "capture.json"));
  const scratch = await createTestTempDirectory("desktop-xml-values-");
  const directory = join(scratch, "bundle");

  const result = await exportDesktopApplication(
    { capture: folder, directory, name: "notes", tasks: [] },
    readers,
  );

  if (result instanceof Error) throw result;
  const seed = "envs/notes/seed/.config/notes/settings.xml";
  expect(result.normalized_result).toMatchObject({
    scrubbed_files: [seed],
    unscrubbed_files: [],
  });
  expect(await readFile(join(directory, seed), "utf8")).toBe(
    `<root path="/home/user/a  b" referenced="/home/user/a&#10;b" kept='a\r\nb'>/home/user/a\nb&#13;c</root>`,
  );
  expect((await readFile(join(folder, "capture.json"))).equals(source)).toBe(
    true,
  );
  const original = captured.state.checkpoints[0]?.retained[0];
  expect(original).toBeDefined();
  expect(
    await readFile(join(folder, "content", original!.sha256), "utf8"),
  ).toBe(xml);
});
