import { parseArgs } from "node:util";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { withCommands } from "../command-scope.mjs";

const { values } = parseArgs({
  options: {
    framework: { type: "string" },
    d8: { type: "string" },
    output: { type: "string" },
    aapt2: { type: "string", default: "aapt2" },
    mirror: { type: "boolean", default: false },
  },
});
for (const name of ["framework", "d8", "output"])
  if (!values[name]) throw new Error(`Missing --${name}`);
const root = resolve(values.output);
await mkdir(root); // Exclusive: never replace an existing fixture or user's output.
const classes = join(root, "classes");
const dex = join(root, "dex");
await mkdir(classes);
await mkdir(dex);
await withCommands(async (run) => {
  await run("javac", [
    "-J-Xmx256m",
    "--release",
    "8",
    "-classpath",
    resolve(values.framework),
    "-d",
    classes,
    resolve(import.meta.dirname, "fixture/Main.java"),
  ]);
  await run("java", [
    "-Xmx256m",
    "-cp",
    resolve(values.d8),
    "com.android.tools.r8.D8",
    "--min-api",
    "24",
    "--lib",
    resolve(values.framework),
    "--output",
    dex,
    ...(await readdir(classes, { recursive: true }))
      .filter((path) => path.endsWith(".class"))
      .sort()
      .map((path) => join(classes, path)),
  ]);
  const unsigned = join(root, "unsigned.apk");
  const resources = join(root, "resources.zip");
  await run(values.aapt2, [
    "compile",
    "--dir",
    resolve(import.meta.dirname, "fixture/res"),
    "-o",
    resources,
  ]);
  await run(values.aapt2, [
    "link",
    "-I",
    resolve(values.framework),
    "--manifest",
    resolve(
      import.meta.dirname,
      values.mirror
        ? "fixture/AndroidManifest.mirror.xml"
        : "fixture/AndroidManifest.xml",
    ),
    "-o",
    unsigned,
    resources,
  ]);
  await run("zip", ["-q", unsigned, "classes.dex"], { cwd: dex });
  const aligned = join(root, "aligned.apk");
  await run("zipalign", ["4", unsigned, aligned]);
  const key = join(root, "fixture.jks");
  await run("keytool", [
    "-genkeypair",
    "-keystore",
    key,
    "-storepass",
    "android",
    "-keypass",
    "android",
    "-alias",
    "fixture",
    "-dname",
    "CN=REA UI Fixture",
    "-keyalg",
    "RSA",
    "-keysize",
    "2048",
    "-validity",
    "30",
  ]);
  const apk = join(root, "ui-probe.apk");
  await run("apksigner", [
    "sign",
    "--ks",
    key,
    "--ks-pass",
    "pass:android",
    "--key-pass",
    "pass:android",
    "--out",
    apk,
    aligned,
  ]);
  const bytes = await readFile(apk);
  console.log(
    JSON.stringify({
      apk,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
});
