import { DatabaseSync } from "node:sqlite";
import { normalizeName } from "./csvImport.js";

export function createStore(databasePath = ":memory:") {
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY,
      student_no TEXT,
      full_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      external_id TEXT,
      UNIQUE(normalized_name, student_no)
    );
    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      level TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS teachers (
      id INTEGER PRIMARY KEY,
      full_name TEXT NOT NULL,
      branch TEXT,
      mebbis_approval_no TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS student_teachers (
      id INTEGER PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id),
      teacher_id INTEGER NOT NULL REFERENCES teachers(id),
      period_start TEXT,
      period_end TEXT,
      UNIQUE(student_id, teacher_id)
    );
    CREATE TABLE IF NOT EXISTS bep_periods (
      id INTEGER PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id),
      period_name TEXT NOT NULL,
      start_date TEXT,
      end_date TEXT,
      status TEXT NOT NULL DEFAULT 'Taslak',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS bep_targets (
      id INTEGER PRIMARY KEY,
      period_id INTEGER NOT NULL REFERENCES bep_periods(id),
      title TEXT NOT NULL,
      behavior TEXT,
      criterion TEXT,
      status TEXT NOT NULL DEFAULT 'Aktif',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS bep_performance_records (
      id INTEGER PRIMARY KEY,
      period_id INTEGER NOT NULL REFERENCES bep_periods(id),
      target_id INTEGER REFERENCES bep_targets(id),
      record_date TEXT NOT NULL,
      result TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS enrollments (
      id INTEGER PRIMARY KEY,
      class_id INTEGER NOT NULL REFERENCES classes(id),
      student_id INTEGER NOT NULL REFERENCES students(id),
      UNIQUE(class_id, student_id)
    );
    CREATE TABLE IF NOT EXISTS attendance_sessions (
      id INTEGER PRIMARY KEY,
      class_id INTEGER NOT NULL REFERENCES classes(id),
      course_id INTEGER REFERENCES courses(id),
      session_date TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS attendance_records (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES attendance_sessions(id),
      student_id INTEGER NOT NULL REFERENCES students(id),
      status TEXT NOT NULL,
      note TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(session_id, student_id)
    );
    CREATE TABLE IF NOT EXISTS import_batches (
      id INTEGER PRIMARY KEY,
      file_name TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      imported_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const seedCount = db
    .prepare("SELECT COUNT(*) AS count FROM students")
    .get().count;
  if (databasePath !== ":memory:" && seedCount === 0) {
    db.exec("BEGIN");
    try {
      const students = [
        ["101", "Ayşe Yılmaz"],
        ["102", "Mehmet Demir"],
        ["103", "Zeynep Kaya"],
        ["104", "Can Öztürk"],
        ["105", "Ela Arslan"],
        ["106", "Kerem Şahin"],
      ];
      const studentInsert = db.prepare(
        "INSERT INTO students(student_no, full_name, normalized_name, external_id) VALUES (?, ?, ?, NULL)",
      );
      const studentIds = students.map(([studentNo, fullName]) => {
        const normalized = fullName
          .normalize("NFKC")
          .toLocaleLowerCase("tr")
          .replace(/\s+/g, " ")
          .trim();
        return Number(
          studentInsert.run(studentNo, fullName, normalized).lastInsertRowid,
        );
      });

      const classResult = db
        .prepare(
          "INSERT INTO classes(name, level) VALUES ('Özel Eğitim 5-A', '5')",
        )
        .run();
      const classId = Number(classResult.lastInsertRowid);
      const courseResult = db
        .prepare(
          "INSERT INTO courses(name, code) VALUES ('Bireysel Ders', 'BD')",
        )
        .run();
      const courseId = Number(courseResult.lastInsertRowid);
      const enrollmentInsert = db.prepare(
        "INSERT INTO enrollments(class_id, student_id) VALUES (?, ?)",
      );
      studentIds.forEach((studentId) =>
        enrollmentInsert.run(classId, studentId),
      );

      const sessionResult = db
        .prepare(
          "INSERT INTO attendance_sessions(class_id, course_id, session_date, note) VALUES (?, ?, '2026-11-18', 'Örnek veri oturumu')",
        )
        .run(classId, courseId);
      const sessionId = Number(sessionResult.lastInsertRowid);
      const attendanceInsert = db.prepare(
        "INSERT INTO attendance_records(session_id, student_id, status, note) VALUES (?, ?, ?, '')",
      );
      studentIds.forEach((studentId, index) =>
        attendanceInsert.run(sessionId, studentId, index === 2 ? "yok" : "var"),
      );
      db.prepare(
        "INSERT INTO import_batches(file_name, source_kind, imported_count) VALUES ('örnek-ogrenci-listesi.csv', 'sample_data', 6)",
      ).run();
      const teacherResult = db
        .prepare(
          "INSERT INTO teachers(full_name, branch, mebbis_approval_no) VALUES ('Örnek Eğitimci', 'Özel Eğitim', 'ÖRNEK')",
        )
        .run();
      const teacherId = Number(teacherResult.lastInsertRowid);
      const assignment = db.prepare(
        "INSERT OR IGNORE INTO student_teachers(student_id, teacher_id, period_start, period_end) VALUES (?, ?, '2026-09-01', '2027-05-31')",
      );
      studentIds.forEach((studentId) => assignment.run(studentId, teacherId));

      const periodInsert = db.prepare(
        "INSERT INTO bep_periods(student_id, period_name, start_date, end_date, status) VALUES (?, '2026-2027 Dönemi', '2026-09-01', '2027-05-31', 'Aktif')",
      );
      const targetInsert = db.prepare(
        "INSERT INTO bep_targets(period_id, title, behavior, criterion, status) VALUES (?, 'Örnek hedef', 'Göstermesi beklenen davranış', 'Bağımsız gerçekleştirme', 'Aktif')",
      );
      const performanceInsert = db.prepare(
        "INSERT INTO bep_performance_records(period_id, target_id, record_date, result, note) VALUES (?, ?, '2026-11-18', ?, 'Örnek kayıt')",
      );
      studentIds.slice(0, 3).forEach((studentId, index) => {
        const periodId = Number(periodInsert.run(studentId).lastInsertRowid);
        const targetId = Number(targetInsert.run(periodId).lastInsertRowid);
        performanceInsert.run(
          periodId,
          targetId,
          index === 2 ? "Geliştirilmeli" : "Başardı",
        );
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const audit = (action, entityType, entityId, detail = "") => {
    db.prepare(
      "INSERT INTO audit_log(action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?)",
    ).run(action, entityType, entityId, detail);
  };

  return {
    close: () => db.close(),
    listStudents: () =>
      db.prepare("SELECT * FROM students ORDER BY full_name").all(),
    previewStudents: (students) =>
      students.map((student) => {
        const existing = db
          .prepare(
            "SELECT * FROM students WHERE (student_no = ? AND student_no <> '') OR normalized_name = ? LIMIT 1",
          )
          .get(
            student.studentNo || "__none__",
            normalizeName(student.fullName),
          );
        return { ...student, existing: existing ?? null };
      }),
    commitImport: (fileName, students) => {
      db.exec("BEGIN");
      try {
        let importedCount = 0;
        for (const student of students) {
          if (!student.fullName) continue;
          const existing = db
            .prepare(
              "SELECT id FROM students WHERE (student_no = ? AND student_no <> '') OR normalized_name = ? LIMIT 1",
            )
            .get(
              student.studentNo || "__none__",
              normalizeName(student.fullName),
            );
          if (existing) {
            db.prepare(
              "UPDATE students SET student_no = CASE WHEN student_no = '' OR student_no IS NULL THEN ? ELSE student_no END, external_id = COALESCE(external_id, ?) WHERE id = ?",
            ).run(student.studentNo, student.externalId ?? null, existing.id);
          } else {
            const result = db
              .prepare(
                "INSERT INTO students(student_no, full_name, normalized_name, external_id) VALUES (?, ?, ?, ?)",
              )
              .run(
                student.studentNo,
                student.fullName,
                normalizeName(student.fullName),
                student.externalId ?? null,
              );
            importedCount += 1;
            audit(
              "import",
              "student",
              Number(result.lastInsertRowid),
              fileName,
            );
          }
        }
        const batch = db
          .prepare(
            "INSERT INTO import_batches(file_name, source_kind, imported_count) VALUES (?, 'authorized_file', ?)",
          )
          .run(fileName, importedCount);
        audit(
          "import",
          "import_batch",
          Number(batch.lastInsertRowid),
          fileName,
        );
        db.exec("COMMIT");
        return {
          batchId: Number(batch.lastInsertRowid),
          importedCount,
        };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    listClasses: () =>
      db
        .prepare(`
        SELECT c.*, COUNT(e.id) AS student_count
        FROM classes c LEFT JOIN enrollments e ON e.class_id = c.id
        GROUP BY c.id ORDER BY c.name
      `)
        .all(),
    createClass: (name, level = "") => {
      const result = db
        .prepare("INSERT INTO classes(name, level) VALUES (?, ?)")
        .run(name, level);
      audit("create", "class", Number(result.lastInsertRowid), name);
      return { id: Number(result.lastInsertRowid), name, level };
    },
    enrollStudent: (classId, studentId) => {
      db.prepare(
        "INSERT OR IGNORE INTO enrollments(class_id, student_id) VALUES (?, ?)",
      ).run(classId, studentId);
      audit("enroll", "enrollment", Number(classId), `student=${studentId}`);
    },
    listCourses: () => db.prepare("SELECT * FROM courses ORDER BY name").all(),
    createCourse: (name, code = "") => {
      const result = db
        .prepare("INSERT INTO courses(name, code) VALUES (?, ?)")
        .run(name, code);
      audit("create", "course", Number(result.lastInsertRowid), name);
      return { id: Number(result.lastInsertRowid), name, code };
    },
    listTeachers: () =>
      db
        .prepare(`
        SELECT t.*, COUNT(st.id) AS student_count
        FROM teachers t
        LEFT JOIN student_teachers st ON st.teacher_id = t.id
        GROUP BY t.id
        ORDER BY t.full_name
      `)
        .all(),
    createTeacher: (fullName, branch = "", mebbisApprovalNo = "") => {
      const result = db
        .prepare(
          "INSERT INTO teachers(full_name, branch, mebbis_approval_no) VALUES (?, ?, ?)",
        )
        .run(fullName, branch, mebbisApprovalNo);
      audit("create", "teacher", Number(result.lastInsertRowid), fullName);
      return { id: Number(result.lastInsertRowid), fullName, branch };
    },
    assignTeacher: (studentId, teacherId) => {
      db.prepare(`
        INSERT OR IGNORE INTO student_teachers(student_id, teacher_id)
        VALUES (?, ?)
      `).run(studentId, teacherId);
      audit(
        "assign",
        "student_teacher",
        Number(teacherId),
        `student=${studentId}`,
      );
    },
    listBepPeriods: () =>
      db
        .prepare(`
        SELECT bp.*, s.full_name, s.student_no,
               COUNT(DISTINCT bt.id) AS target_count
        FROM bep_periods bp
        JOIN students s ON s.id = bp.student_id
        LEFT JOIN bep_targets bt ON bt.period_id = bp.id
        GROUP BY bp.id
        ORDER BY bp.start_date DESC, s.full_name
      `)
        .all(),
    createBepPeriod: (studentId, periodName, startDate, endDate) => {
      const result = db
        .prepare(`
        INSERT INTO bep_periods(student_id, period_name, start_date, end_date)
        VALUES (?, ?, ?, ?)
      `)
        .run(studentId, periodName, startDate, endDate);
      audit("create", "bep_period", Number(result.lastInsertRowid), periodName);
      return { id: Number(result.lastInsertRowid) };
    },
    listBepTargets: (periodId) =>
      db
        .prepare(`
        SELECT * FROM bep_targets
        WHERE period_id = ?
        ORDER BY id
      `)
        .all(periodId),
    createBepTarget: (periodId, title, behavior, criterion) => {
      const result = db
        .prepare(`
        INSERT INTO bep_targets(period_id, title, behavior, criterion)
        VALUES (?, ?, ?, ?)
      `)
        .run(periodId, title, behavior, criterion);
      audit("create", "bep_target", Number(result.lastInsertRowid), title);
      return { id: Number(result.lastInsertRowid) };
    },
    listPerformanceRecords: () =>
      db
        .prepare(`
        SELECT pr.*, bp.period_name, s.full_name, s.student_no, bt.title AS target_title
        FROM bep_performance_records pr
        JOIN bep_periods bp ON bp.id = pr.period_id
        JOIN students s ON s.id = bp.student_id
        LEFT JOIN bep_targets bt ON bt.id = pr.target_id
        ORDER BY pr.record_date DESC, s.full_name
      `)
        .all(),
    savePerformanceRecord: (
      periodId,
      targetId,
      recordDate,
      result,
      note = "",
    ) => {
      db.prepare(`
        INSERT INTO bep_performance_records(period_id, target_id, record_date, result, note)
        VALUES (?, ?, ?, ?, ?)
      `).run(periodId, targetId || null, recordDate, result, note);
      audit("create", "bep_performance_record", Number(periodId), result);
    },
    createSession: (classId, courseId, sessionDate, note = "") => {
      const result = db
        .prepare(
          "INSERT INTO attendance_sessions(class_id, course_id, session_date, note) VALUES (?, ?, ?, ?)",
        )
        .run(classId, courseId || null, sessionDate, note);
      audit(
        "create",
        "attendance_session",
        Number(result.lastInsertRowid),
        sessionDate,
      );
      return { id: Number(result.lastInsertRowid) };
    },
    listSessions: () =>
      db
        .prepare(`
        SELECT s.*, c.name AS class_name, co.name AS course_name
        FROM attendance_sessions s
        JOIN classes c ON c.id = s.class_id
        LEFT JOIN courses co ON co.id = s.course_id
        ORDER BY s.session_date DESC, s.id DESC
      `)
        .all(),
    getAttendance: (sessionId) =>
      db
        .prepare(`
        SELECT s.id AS student_id, s.full_name, s.student_no,
               ar.status, ar.note
        FROM attendance_sessions ats
        JOIN enrollments e ON e.class_id = ats.class_id
        JOIN students s ON s.id = e.student_id
        LEFT JOIN attendance_records ar
          ON ar.student_id = s.id AND ar.session_id = ats.id
        WHERE ats.id = ?
        ORDER BY s.full_name
      `)
        .all(sessionId),
    saveAttendance: (sessionId, records) => {
      db.exec("BEGIN");
      try {
        for (const record of records) {
          db.prepare(`
            INSERT INTO attendance_records(session_id, student_id, status, note)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(session_id, student_id) DO UPDATE SET
              status = excluded.status,
              note = excluded.note,
              updated_at = CURRENT_TIMESTAMP
          `).run(sessionId, record.studentId, record.status, record.note ?? "");
          audit(
            "update",
            "attendance_record",
            Number(record.studentId),
            `session=${sessionId};status=${record.status}`,
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    listAudit: () =>
      db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 100").all(),
  };
}
