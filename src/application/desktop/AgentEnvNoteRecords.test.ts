import { expect, it } from "vitest";

import { parseAgentEnvNotes } from "../../../tests/fixtures/fakeAgentEnvComputer.js";

const record = { id: 1, kind: "call" };

it("keeps complete note records and an unfinished trailing fragment", () => {
  expect(parseAgentEnvNotes(`${JSON.stringify(record)}\n{"id":`)).toEqual([
    record,
  ]);
  expect(parseAgentEnvNotes(`${JSON.stringify(record)}\n`)).toEqual([record]);
  expect(parseAgentEnvNotes("")).toEqual([]);
});

it("rejects a newline-terminated note that is not a record", () => {
  expect(() =>
    parseAgentEnvNotes(`${JSON.stringify(record)}\n{bad}\n`),
  ).toThrow(SyntaxError);
  expect(() => parseAgentEnvNotes("{bad}\n")).toThrow(SyntaxError);
});
