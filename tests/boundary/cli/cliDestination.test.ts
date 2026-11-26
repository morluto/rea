import { afterEach, expect, it } from "vitest";

import { cliResultDestination } from "../../../src/cli/cliDestination.js";

const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
afterEach(() => {
  if (original === undefined) Reflect.deleteProperty(process.stdout, "isTTY");
  else Object.defineProperty(process.stdout, "isTTY", original);
});

it.each([true, false])(
  "keeps the terminal presentation (isTTY %s) for captured output",
  async (tty) => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: tty,
      configurable: true,
    });
    const written: string[] = [];
    const destination = cliResultDestination((text) => written.push(text));
    expect((destination as { isTTY?: boolean }).isTTY).toBe(tty);
    await new Promise<void>((resolve, reject) =>
      destination.write("document", (cause) =>
        cause == null ? resolve() : reject(cause),
      ),
    );
    expect(written).toEqual(["document"]);
  },
);

it("writes to the process stream when nothing captures output", () => {
  expect(cliResultDestination(undefined)).toBe(process.stdout);
});
