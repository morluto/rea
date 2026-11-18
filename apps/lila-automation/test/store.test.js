import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.js";

test("import, enrollment and attendance work end to end", () => {
  const store = createStore(":memory:");
  try {
    const imported = store.commitImport("ogrenciler.csv", [
      { studentNo: "101", fullName: "Ayşe Yılmaz" },
      { studentNo: "102", fullName: "Mehmet Demir" },
    ]);
    assert.equal(imported.importedCount, 2);

    const students = store.listStudents();
    assert.equal(students.length, 2);

    const classRow = store.createClass("5-A", "5");
    for (const student of students) {
      store.enrollStudent(classRow.id, student.id);
    }

    const course = store.createCourse("Matematik", "MAT");
    const session = store.createSession(classRow.id, course.id, "2026-11-18");
    store.saveAttendance(session.id, [
      { studentId: students[0].id, status: "var", note: "" },
      { studentId: students[1].id, status: "izinli", note: "Belge var" },
    ]);

    const records = store.getAttendance(session.id);
    assert.equal(records.length, 2);
    assert.equal(
      records.find((row) => row.student_id === students[1].id).status,
      "izinli",
    );

    const repeat = store.commitImport("ogrenciler.csv", [
      { studentNo: "101", fullName: "Ayşe Yılmaz" },
    ]);
    assert.equal(repeat.importedCount, 0);

    const period = store.createBepPeriod(
      students[0].id,
      "2026-2027",
      "2026-09-01",
      "2027-05-31",
    );
    const target = store.createBepTarget(
      period.id,
      "İki adımlı talimatı takip eder",
      "Talimatı dinler ve uygular",
      "Üç denemede iki kez bağımsız",
    );
    assert.ok(target.id);
    store.savePerformanceRecord(
      period.id,
      target.id,
      "2026-11-18",
      "Başardı",
      "",
    );
    assert.equal(store.listPerformanceRecords().length >= 1, true);
  } finally {
    store.close();
  }
});
