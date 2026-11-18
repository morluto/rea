export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') {
      field += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field.trim());
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field.trim());
      field = "";
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }

  if (quoted) throw new Error("CSV içinde kapatılmamış tırnak alanı bulundu.");
  row.push(field.trim());
  if (row.some((value) => value.length > 0)) rows.push(row);
  if (rows.length === 0) throw new Error("Dosyada veri bulunamadı.");

  const headers = rows
    .shift()
    .map((header) =>
      header
        .normalize("NFKC")
        .toLocaleLowerCase("tr")
        .replace(/\s+/g, " ")
        .trim(),
    );
  return { headers, rows };
}

export function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("tr")
    .replace(/\s+/g, " ")
    .trim();
}

export function previewImport(csvText, mapping, fileName = "ogrenciler.csv") {
  const parsed = parseCsv(csvText);
  const findIndex = (aliases) => {
    if (
      mapping &&
      mapping.fullName &&
      parsed.headers.includes(mapping.fullName)
    ) {
      return parsed.headers.indexOf(mapping.fullName);
    }
    return parsed.headers.findIndex((header) =>
      aliases.some((alias) => header.includes(alias)),
    );
  };

  const nameIndex = findIndex([
    "ad soyad",
    "adı soyadı",
    "isim soyisim",
    "öğrenci adı",
  ]);
  const numberIndex = findIndex([
    "öğrenci no",
    "ogrenci no",
    "okul no",
    "numara",
  ]);

  const students = parsed.rows.map((row, index) => ({
    line: index + 2,
    studentNo: numberIndex >= 0 ? String(row[numberIndex] ?? "").trim() : "",
    fullName: nameIndex >= 0 ? String(row[nameIndex] ?? "").trim() : "",
  }));

  const errors = [];
  students.forEach((student) => {
    if (!student.fullName)
      errors.push({ line: student.line, message: "Ad soyad boş." });
  });

  return {
    fileName,
    headers: parsed.headers,
    students,
    errors,
  };
}
