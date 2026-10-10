import { expect, it } from "vitest";

import { TerminalRenderer } from "./TerminalRenderer.js";

const renderFrames = async (
  data: string,
  normalize: (value: string) => string = (value) => value,
) => {
  const renderer = new TerminalRenderer({
    columns: 20,
    rows: 4,
    scrollback: 10,
    maxBytes: 100_000,
    normalize,
  });
  renderer.write(data, 0);
  const frames = await renderer.frames();
  const retention = renderer.retention();
  await renderer.dispose();
  return { frames, retention };
};

it("omits trailing blank cells from visible lines without losing rows", async () => {
  const { frames, retention } = await renderFrames(
    "left  right   \r\n\r\n  indented",
  );
  const [frame] = frames;
  expect(frame?.lines).toEqual(["left  right", "", "  indented", ""]);
  // Fixed-width rows remain recoverable from the recorded column count.
  expect(frame?.lines.map((line) => line.padEnd(frame.columns, " "))).toEqual([
    "left  right         ",
    " ".repeat(20),
    "  indented          ",
    " ".repeat(20),
  ]);
  expect(retention.retained_bytes).toBe(
    Buffer.byteLength(frame?.serialized_state ?? "") +
      Buffer.byteLength("left  right  indented"),
  );
});

it("trims only after normalization sees the full-width row", async () => {
  const { frames } = await renderFrames("pid 4242", (value) =>
    value.replace(/4242 +$/u, "<pid>"),
  );
  expect(frames[0]?.lines[0]).toBe("pid <pid>");
});
