import { Writable } from "node:stream";
import { expect, it } from "vitest";

import { createCliResultOutput } from "../../../src/cli/cliResultOutput.js";
import { parseCliOutputArguments } from "../../../src/cliOutput.js";

it("retains failed output ownership when a terminal notice cannot be written", async () => {
  const cause = Object.assign(new Error("broken pipe during notice"), {
    code: "EPIPE",
  });
  let written = "";
  const output = createCliResultOutput(
    parseCliOutputArguments([]),
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        const text = chunk.toString("utf8");
        if (text.includes("Update available")) done(cause);
        else {
          written += text;
          done();
        }
      },
    }),
  );
  if (output === undefined) throw new Error("Missing output owner");
  await expect(
    output.write(
      { answer: 42 },
      {
        command: "fixture",
        duration: "0ms",
        cta: {
          description: "Update available",
          commands: [{ command: "rea --update" }],
        },
      },
    ),
  ).rejects.toBe(cause);
  expect(written).toBe("answer: 42\n");
  expect(output.handled).toBe(true);
  expect(output.failed).toBe(true);
  expect(
    await output.recoverFormattingFailure(
      new RangeError("Invalid string length"),
    ),
  ).toBe(false);
});
