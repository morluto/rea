import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, previewImport } from "../src/csvImport.js";

test("CSV parser handles Turkish headers and quoted commas", () => {
  const csv = 'Öğrenci No,Ad Soyad\n101,"Ayşe, Yılmaz"\n102,Mehmet Demir';
  const parsed = parseCsv(csv);
  assert.deepEqual(parsed.headers, ["öğrenci no", "ad soyad"]);
  assert.equal(parsed.rows[0][1], "Ayşe, Yılmaz");
});

test("import preview reports missing names and detects rows", () => {
  const preview = previewImport(
    "Öğrenci No,Ad Soyad\n101,Ayşe Yılmaz\n102,\n",
    {},
  );
  assert.equal(preview.students.length, 2);
  assert.equal(preview.students[0].fullName, "Ayşe Yılmaz");
  assert.equal(preview.errors.length, 1);
  assert.equal(preview.errors[0].line, 3);
});
