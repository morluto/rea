import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./src/store.js";
import { previewImport } from "./src/csvImport.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 4173);
const databasePath = process.env.LILA_DB || path.join(__dirname, "lila.sqlite");
const store = createStore(databasePath);

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 2_000_000) throw new Error("İstek boyutu sınırı aşıldı.");
  }
  return body ? JSON.parse(body) : {};
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function serveStatic(request, response) {
  const url = new URL(request.url, "http://127.0.0.1");
  let relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (relative.includes("..")) throw new Error("Geçersiz dosya yolu.");
  const filePath = path.join(publicDir, relative);
  const content = await fs.readFile(filePath);
  const extension = path.extname(filePath);
  const types = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
  };
  response.writeHead(200, {
    "content-type": types[extension] || "application/octet-stream",
  });
  response.end(content);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (!url.pathname.startsWith("/api/")) {
      await serveStatic(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/students") {
      sendJson(response, 200, store.listStudents());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/classes") {
      sendJson(response, 200, store.listClasses());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/classes") {
      const body = await readJson(request);
      if (!body.name) throw new Error("Sınıf adı gerekli.");
      sendJson(
        response,
        201,
        store.createClass(body.name.trim(), body.level || ""),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/enrollments") {
      const body = await readJson(request);
      store.enrollStudent(Number(body.classId), Number(body.studentId));
      sendJson(response, 201, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/courses") {
      sendJson(response, 200, store.listCourses());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/courses") {
      const body = await readJson(request);
      if (!body.name) throw new Error("Ders adı gerekli.");
      sendJson(
        response,
        201,
        store.createCourse(body.name.trim(), body.code || ""),
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/teachers") {
      sendJson(response, 200, store.listTeachers());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/teachers") {
      const body = await readJson(request);
      if (!body.fullName) throw new Error("Eğitimci adı gerekli.");
      sendJson(
        response,
        201,
        store.createTeacher(
          body.fullName.trim(),
          body.branch || "",
          body.mebbisApprovalNo || "",
        ),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/student-teachers") {
      const body = await readJson(request);
      store.assignTeacher(Number(body.studentId), Number(body.teacherId));
      sendJson(response, 201, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/bep-periods") {
      sendJson(response, 200, store.listBepPeriods());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/bep-periods") {
      const body = await readJson(request);
      if (!body.studentId || !body.periodName)
        throw new Error("Öğrenci ve dönem adı gerekli.");
      sendJson(
        response,
        201,
        store.createBepPeriod(
          Number(body.studentId),
          body.periodName,
          body.startDate || "",
          body.endDate || "",
        ),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/bep-targets") {
      const body = await readJson(request);
      if (!body.periodId || !body.title)
        throw new Error("Dönem ve hedef gerekli.");
      sendJson(
        response,
        201,
        store.createBepTarget(
          Number(body.periodId),
          body.title,
          body.behavior || "",
          body.criterion || "",
        ),
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/bep-performance") {
      sendJson(response, 200, store.listPerformanceRecords());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/bep-performance") {
      const body = await readJson(request);
      if (!body.periodId || !body.recordDate || !body.result) {
        throw new Error("Dönem, tarih ve sonuç gerekli.");
      }
      store.savePerformanceRecord(
        Number(body.periodId),
        body.targetId ? Number(body.targetId) : null,
        body.recordDate,
        body.result,
        body.note || "",
      );
      sendJson(response, 201, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/import/preview") {
      const body = await readJson(request);
      if (!body.csv) throw new Error("CSV içeriği gerekli.");
      const preview = previewImport(body.csv, body.mapping, body.fileName);
      sendJson(response, 200, {
        ...preview,
        matches: store.previewStudents(preview.students),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/import/commit") {
      const body = await readJson(request);
      if (!Array.isArray(body.students))
        throw new Error("Öğrenci listesi gerekli.");
      sendJson(
        response,
        201,
        store.commitImport(body.fileName || "ogrenciler.csv", body.students),
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/sessions") {
      sendJson(response, 200, store.listSessions());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const body = await readJson(request);
      if (!body.classId || !body.sessionDate)
        throw new Error("Sınıf ve tarih gerekli.");
      sendJson(
        response,
        201,
        store.createSession(
          Number(body.classId),
          body.courseId ? Number(body.courseId) : null,
          body.sessionDate,
          body.note || "",
        ),
      );
      return;
    }
    const attendanceMatch = url.pathname.match(
      /^\/api\/sessions\/(\d+)\/attendance$/,
    );
    if (attendanceMatch) {
      const sessionId = Number(attendanceMatch[1]);
      if (request.method === "GET") {
        sendJson(response, 200, store.getAttendance(sessionId));
        return;
      }
      if (request.method === "PUT") {
        const body = await readJson(request);
        store.saveAttendance(sessionId, body.records || []);
        sendJson(response, 200, { ok: true });
        return;
      }
    }
    if (request.method === "GET" && url.pathname === "/api/audit") {
      sendJson(response, 200, store.listAudit());
      return;
    }
    sendJson(response, 404, { error: "Endpoint bulunamadı." });
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : "Beklenmeyen hata.",
    });
  }
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(port, "127.0.0.1", () => {
  console.log(`Lila otomasyon uygulaması: http://127.0.0.1:${port}`);
});
