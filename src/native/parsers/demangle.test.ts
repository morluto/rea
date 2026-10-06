import { expect, it } from "vitest";
import { parseDemangledSymbols } from "./demangle.js";

it.each(["ordinary name ", "ordinary\t", " "])(
  "preserves unchanged final symbol text: %j",
  (input) => {
    expect(parseDemangledSymbols([input], `${input}\n`)).toEqual([
      { input, output: input, status: "unchanged" },
    ]);
  },
);

it("removes only the line terminator and preserves mixed output ordering", () => {
  expect(
    parseDemangledSymbols(
      ["$s4main5helloyyF", "plain "],
      "main.hello() -> ()\r\nplain \r\n",
    ),
  ).toEqual([
    {
      input: "$s4main5helloyyF",
      output: "main.hello() -> ()",
      status: "demangled",
    },
    { input: "plain ", output: "plain ", status: "unchanged" },
  ]);
});
