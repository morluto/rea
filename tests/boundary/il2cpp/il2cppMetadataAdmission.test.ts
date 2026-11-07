import { expect, it } from "vitest";
import { createIl2cppMetadataAdmission } from "../../../src/il2cpp/Il2cppMetadataAdmission.js";

const refused = () => {
  throw new Error("report allowance");
};

it("charges a wasm row's indices at their serialized width", () => {
  const row = {
    state: "code",
    address: null,
    rva: null,
    table_index: 4294967295,
    function_index: 4294967295,
  };
  const width = JSON.stringify(row).length;
  // One byte short of the row refuses it before it is retained.
  expect(() =>
    createIl2cppMetadataAdmission(width - 1, refused, true).onRow(row),
  ).toThrow("report allowance");
  // Exactly the row fits.
  expect(() =>
    createIl2cppMetadataAdmission(width, refused, true).onRow(row),
  ).not.toThrow();
});
