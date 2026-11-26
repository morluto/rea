import { expect, it } from "vitest";
import { privateIdaInput } from "../../../../scripts/lib/ida-private-input.mjs";

const target = "/samples/target.exe.i64";
const metadata = {
  // A database saved beside its executable still records that executable.
  input_path: "/samples/target.exe",
  idb_path: "/tmp/rea-ida-1/target.exe.i64",
};

it("binds a database target's private copy by its opened database", () => {
  expect(privateIdaInput(metadata, target, true)).toBe(metadata.idb_path);
  expect(() =>
    privateIdaInput({ ...metadata, idb_path: null }, target, true),
  ).toThrow();
});

it("binds an executable target's private copy by its input", () => {
  const input = { input_path: "/tmp/rea-ida-1/target.exe", idb_path: null };
  expect(privateIdaInput(input, "/samples/target.exe", false)).toBe(
    input.input_path,
  );
  expect(() => privateIdaInput(input, input.input_path, false)).toThrow();
});
