import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parse } from "@babel/parser";
const [output, ...files] = process.argv.slice(2);
const rows = [];
for (const file of files) {
  const text = await readFile(file, "utf8");
  const ast = parse(text, { sourceType: "unambiguous" });
  const strings = [];
  let nodes = 0;
  const stack = [ast];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== "object") continue;
    if (Array.isArray(n)) {
      stack.push(...n);
      continue;
    }
    if (typeof n.type === "string") nodes++;
    if (n.type === "StringLiteral") {
      let oracle = false;
      try {
        oracle = JSON.parse(text.slice(n.start, n.end)) === n.value;
      } catch {}
      strings.push({
        start: n.start,
        end: n.end,
        units: n.value.length,
        jsonBytes: Buffer.byteLength(JSON.stringify(n.value)),
        oracle,
      });
    }
    if (
      n.type === "TemplateLiteral" &&
      n.expressions.length === 0 &&
      n.quasis[0].value.cooked !== null
    ) {
      const value = n.quasis[0].value.cooked;
      const raw = text.slice(n.start + 1, n.end - 1);
      strings.push({
        start: n.start,
        end: n.end,
        units: value.length,
        jsonBytes: Buffer.byteLength(JSON.stringify(value)),
        oracle: !raw.includes("\\") && raw === value,
        template: true,
      });
    }
    for (const [k, v] of Object.entries(n))
      if (
        !["loc", "extra", "comments", "tokens"].includes(k) &&
        v &&
        typeof v === "object"
      )
        stack.push(v);
  }
  strings.sort((a, b) => b.units - a.units);
  rows.push({
    file,
    bytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
    nodes,
    strings: strings.length,
    largest: strings.slice(0, 5),
  });
}
await writeFile(output, JSON.stringify(rows, null, 2));
console.log(JSON.stringify(rows));
