const api = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "İstek başarısız.");
  return value;
};

const $ = (selector) => document.querySelector(selector);

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document
      .querySelectorAll(".tab, .panel")
      .forEach((element) => element.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(tab.dataset.tab).classList.add("active");
    const titles = {
      dashboard: "Genel bakış",
      import: "Öğrenci içe aktarma",
      students: "Öğrenciler",
      classes: "Derslik ve planlama",
      attendance: "Yoklama ve seanslar",
      bep: "BEP ve EK-4",
    };
    $("#pageTitle").textContent = titles[tab.dataset.tab] || "Okul Otomasyonu";
  });
});

document.querySelectorAll("[data-go-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelector(`.tab[data-tab="${button.dataset.goTab}"]`)?.click();
  });
});

let currentPreview = null;

$("#csvFile").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const csv = await file.text();
  try {
    currentPreview = await api("/api/import/preview", {
      method: "POST",
      body: JSON.stringify({ csv, fileName: file.name }),
    });
    renderPreview(currentPreview);
  } catch (error) {
    $("#preview").innerHTML =
      `<p class="warning">${escapeHtml(error.message)}</p>`;
  }
});

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderPreview(preview) {
  const rows = preview.matches
    .map(
      (student) => `
    <tr>
      <td>${escapeHtml(student.line)}</td>
      <td>${escapeHtml(student.fullName)}</td>
      <td>${escapeHtml(student.studentNo)}</td>
      <td>${student.existing ? `<span class="match">Mevcut kayıt: ${escapeHtml(student.existing.full_name)}</span>` : "Yeni"}</td>
    </tr>
  `,
    )
    .join("");
  const errors = preview.errors
    .map(
      (error) =>
        `<li>${escapeHtml(error.line)}: ${escapeHtml(error.message)}</li>`,
    )
    .join("");
  $("#preview").innerHTML = `
    <div class="card">
      <h3>${escapeHtml(preview.fileName)}</h3>
      ${errors ? `<ul class="warning">${errors}</ul>` : ""}
      <table>
        <thead><tr><th>Satır</th><th>Ad soyad</th><th>No</th><th>Durum</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <button id="commitImport">Önizlemeyi onayla ve kaydet</button>
    </div>
  `;
  $("#commitImport").addEventListener("click", async () => {
    try {
      await api("/api/import/commit", {
        method: "POST",
        body: JSON.stringify({
          fileName: preview.fileName,
          students: preview.students.filter((student) => student.fullName),
        }),
      });
      $("#preview").insertAdjacentHTML(
        "beforeend",
        "<p><strong>Kayıt tamamlandı.</strong></p>",
      );
      await refresh();
    } catch (error) {
      alert(error.message);
    }
  });
}

async function refresh() {
  const [students, classes, courses, sessions, periods, performance, teachers] =
    await Promise.all([
      api("/api/students"),
      api("/api/classes"),
      api("/api/courses"),
      api("/api/sessions"),
      api("/api/bep-periods"),
      api("/api/bep-performance"),
      api("/api/teachers"),
    ]);
  $("#summaryCards").innerHTML = `
    <div class="summaryCard"><span>Aktif öğrenci</span><strong>${students.length}</strong></div>
    <div class="summaryCard"><span>Derslik</span><strong>${classes.length}</strong></div>
    <div class="summaryCard"><span>Ders</span><strong>${courses.length}</strong></div>
    <div class="summaryCard"><span>Seans</span><strong>${sessions.length}</strong></div>
    <div class="summaryCard"><span>Eğitimci</span><strong>${teachers.length}</strong></div>
  `;
  $("#todaySessions").innerHTML =
    sessions
      .slice(0, 5)
      .map(
        (session) => `
    <div class="card session" data-session-id="${session.id}">
      <strong>${escapeHtml(session.class_name)}</strong>
      <div>${escapeHtml(session.course_name || "Ders seçilmedi")} · ${escapeHtml(session.session_date)}</div>
    </div>
  `,
      )
      .join("") || "<p>Seans kaydı bulunmuyor.</p>";
  $("#studentList").innerHTML = `<table>
    <thead><tr><th>Ad soyad</th><th>Öğrenci no</th></tr></thead>
    <tbody>${students
      .map(
        (student) =>
          `<tr><td>${escapeHtml(student.full_name)}</td><td>${escapeHtml(student.student_no || "")}</td></tr>`,
      )
      .join("")}</tbody>
  </table>`;

  $("#classList").innerHTML =
    classes
      .map(
        (item) =>
          `<p><strong>${escapeHtml(item.name)}</strong> — ${item.student_count} öğrenci</p>`,
      )
      .join("") || "<p>Henüz sınıf yok.</p>";
  $("#courseList").innerHTML =
    courses
      .map(
        (item) =>
          `<p>${escapeHtml(item.name)} ${item.code ? `(${escapeHtml(item.code)})` : ""}</p>`,
      )
      .join("") || "<p>Henüz ders yok.</p>";

  document
    .querySelectorAll(
      "#enrollForm select[name=classId], #sessionForm select[name=classId]",
    )
    .forEach((select) => {
      select.innerHTML =
        `<option value="">Sınıf seç</option>` +
        classes
          .map(
            (item) =>
              `<option value="${item.id}">${escapeHtml(item.name)}</option>`,
          )
          .join("");
    });
  $("#enrollForm select[name=studentId]").innerHTML =
    `<option value="">Öğrenci seç</option>` +
    students
      .map(
        (student) =>
          `<option value="${student.id}">${escapeHtml(student.full_name)}</option>`,
      )
      .join("");
  $("#sessionForm select[name=courseId]").innerHTML =
    `<option value="">Ders seç</option>` +
    courses
      .map(
        (item) =>
          `<option value="${item.id}">${escapeHtml(item.name)}</option>`,
      )
      .join("");
  $("#sessionForm input[name=sessionDate]").value = new Date()
    .toISOString()
    .slice(0, 10);
  $("#sessionList").innerHTML =
    sessions
      .map(
        (session) => `
    <div class="card session" data-session-id="${session.id}">
      <strong>${escapeHtml(session.session_date)}</strong>
      — ${escapeHtml(session.class_name)}
      ${session.course_name ? `— ${escapeHtml(session.course_name)}` : ""}
    </div>
  `,
      )
      .join("") || "<p>Henüz yoklama oturumu yok.</p>";
  document.querySelectorAll(".session").forEach((item) => {
    item.addEventListener("click", () =>
      openAttendance(Number(item.dataset.sessionId)),
    );
  });
  const studentOptions = students
    .map(
      (student) =>
        `<option value="${student.id}">${escapeHtml(student.full_name)}</option>`,
    )
    .join("");
  const periodOptions = periods
    .map(
      (period) =>
        `<option value="${period.id}">${escapeHtml(period.full_name)} — ${escapeHtml(period.period_name)}</option>`,
    )
    .join("");
  $("#bepPeriodForm select[name=studentId]").innerHTML =
    `<option value="">Öğrenci seç</option>${studentOptions}`;
  $("#bepPeriodForm input[name=startDate]").value = "2026-09-01";
  $("#bepPeriodForm input[name=endDate]").value = "2027-05-31";
  document
    .querySelectorAll(
      "#bepTargetForm select[name=periodId], #performanceForm select[name=periodId]",
    )
    .forEach((select) => {
      select.innerHTML = `<option value="">Dönem seç</option>${periodOptions}`;
    });
  $("#performanceForm input[name=recordDate]").value = new Date()
    .toISOString()
    .slice(0, 10);
  $("#bepList").innerHTML = performance.length
    ? `<table>
        <thead><tr><th>Öğrenci</th><th>Dönem</th><th>Sonuç</th><th>Tarih</th></tr></thead>
        <tbody>${performance
          .slice(0, 20)
          .map(
            (record) =>
              `<tr>
            <td>${escapeHtml(record.full_name)}</td>
            <td>${escapeHtml(record.period_name)}</td>
            <td>${escapeHtml(record.result)}</td>
            <td>${escapeHtml(record.record_date)}</td>
          </tr>`,
          )
          .join("")}</tbody>
      </table>`
    : "<p>Performans kaydı bulunmuyor.</p>";
}

async function openAttendance(sessionId) {
  const records = await api(`/api/sessions/${sessionId}/attendance`);
  $("#attendanceEditor").innerHTML = `
    <div class="card">
      <h3>Yoklama kaydı</h3>
      <table>
        <thead><tr><th>Öğrenci</th><th>Durum</th><th>Not</th></tr></thead>
        <tbody>${records
          .map(
            (record) => `
          <tr>
            <td>${escapeHtml(record.full_name)}</td>
            <td>
              <select data-student-id="${record.student_id}" class="attendance-status">
                ${["var", "yok", "izinli", "geç"]
                  .map(
                    (status) =>
                      `<option ${record.status === status ? "selected" : ""}>${status}</option>`,
                  )
                  .join("")}
              </select>
            </td>
            <td><input class="attendance-note" data-student-id="${record.student_id}" value="${escapeHtml(record.note || "")}" /></td>
          </tr>
        `,
          )
          .join("")}</tbody>
      </table>
      <button id="saveAttendance">Yoklamayı kaydet</button>
    </div>
  `;
  $("#saveAttendance").addEventListener("click", async () => {
    const recordsToSave = [
      ...document.querySelectorAll(".attendance-status"),
    ].map((select) => ({
      studentId: Number(select.dataset.studentId),
      status: select.value,
      note:
        document.querySelector(
          `.attendance-note[data-student-id="${select.dataset.studentId}"]`,
        )?.value || "",
    }));
    await api(`/api/sessions/${sessionId}/attendance`, {
      method: "PUT",
      body: JSON.stringify({ records: recordsToSave }),
    });
    alert("Yoklama kaydedildi.");
  });
}

$("#classForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await api("/api/classes", {
    method: "POST",
    body: JSON.stringify({ name: form.get("name"), level: form.get("level") }),
  });
  event.currentTarget.reset();
  await refresh();
});

$("#courseForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await api("/api/courses", {
    method: "POST",
    body: JSON.stringify({ name: form.get("name"), code: form.get("code") }),
  });
  event.currentTarget.reset();
  await refresh();
});

$("#enrollForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await api("/api/enrollments", {
    method: "POST",
    body: JSON.stringify({
      classId: Number(form.get("classId")),
      studentId: Number(form.get("studentId")),
    }),
  });
  await refresh();
});

$("#sessionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      classId: Number(form.get("classId")),
      courseId: form.get("courseId") ? Number(form.get("courseId")) : null,
      sessionDate: form.get("sessionDate"),
      note: form.get("note"),
    }),
  });
  await refresh();
});

$("#bepPeriodForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await api("/api/bep-periods", {
    method: "POST",
    body: JSON.stringify({
      studentId: Number(form.get("studentId")),
      periodName: form.get("periodName"),
      startDate: form.get("startDate"),
      endDate: form.get("endDate"),
    }),
  });
  await refresh();
});

$("#bepTargetForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await api("/api/bep-targets", {
    method: "POST",
    body: JSON.stringify({
      periodId: Number(form.get("periodId")),
      title: form.get("title"),
      behavior: form.get("behavior"),
      criterion: form.get("criterion"),
    }),
  });
  await refresh();
});

$("#performanceForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await api("/api/bep-performance", {
    method: "POST",
    body: JSON.stringify({
      periodId: Number(form.get("periodId")),
      recordDate: form.get("recordDate"),
      result: form.get("result"),
      note: form.get("note"),
    }),
  });
  await refresh();
});

refresh().catch((error) => {
  $("#dataStatus").textContent = error.message;
});
