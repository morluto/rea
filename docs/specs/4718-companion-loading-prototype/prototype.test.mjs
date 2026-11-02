import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT, LIMITS, digest, strictJson, resolveManual, resolveForHost, planRegistration, approvePlan, planDisable, health } from "./resolver.mjs";
import { planLegacyRemoval } from "./migration.mjs";

const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "rea-companion-prototype-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "selected-package");
  await mkdir(packageRoot);
  const skill = Buffer.from("For the requested reconstruction, record the evidence.\n");
  const reference = Buffer.from("Record remaining proof gaps.\n");
  const helper = Buffer.from("throw new Error('must never execute');\n");
  await writeFile(join(packageRoot, "SKILL.md"), skill);
  await writeFile(join(packageRoot, "reference.md"), reference);
  await writeFile(join(packageRoot, "helper.mjs"), helper);
  const manifest = { schemaVersion: 1, id: "example", version: "0.1.0", description: "Requested reconstruction planning",
    entrypoint: "SKILL.md", contract: CONTRACT, files: { "SKILL.md": digest(skill), "reference.md": digest(reference), "helper.mjs": digest(helper) } };
  const manifestPath = join(packageRoot, "manifest.json");
  await writeFile(manifestPath, json(manifest));
  const scope = { client: "codex", profileRoot: join(root, "custom-profile"), reaRoot: join(root, "selected-rea") };
  const entry = { id: "example", root: packageRoot, manifest: "manifest.json", manifestDigest: digest(json(manifest)), enabled: true, delivery: "checked-text" };
  const registry = { schemaVersion: 1, scope, entries: [entry] };
  const registryPath = join(root, "registry.json");
  await writeFile(registryPath, json(registry));
  const input = { registryPath, scope, id: entry.id, expectedIdentity: entry.manifestDigest, relevant: true };
  const save = async () => { await writeFile(manifestPath, json(manifest)); entry.manifestDigest = digest(json(manifest));
    input.expectedIdentity = entry.manifestDigest; await writeFile(registryPath, json(registry)); };
  return { root, packageRoot, skill, reference, manifest, manifestPath, scope, entry, registry, registryPath, input, save };
}
const refusal = (result, tag) => { assert.equal(result.ok, false, JSON.stringify(result)); if (tag) assert.equal(result.error.tag, tag); };

test("manual checked text returns exact selected entry/reference and provenance; host stays inactive", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.registryPath);
  const result = await resolveManual(f.input);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.text, f.skill.toString());
  assert.equal(result.value.baseDirectory, f.packageRoot);
  assert.equal(result.value.hostDelivery, "not-assessed");
  assert.equal((await resolveManual({ ...f.input, path: "reference.md" })).value.text, f.reference.toString());
  refusal(await resolveForHost({ ...f.input, trusted: true, freshSession: true }), "binding-unavailable");
  assert.deepEqual(await readFile(f.registryPath), before);
  assert.equal((await health(f.input)).value.content, "checked");
  assert.equal((await health(f.input)).value.setupUpdate, "suspended");
});

test("irrelevant requests and disabled grants do not read missing package content", async (t) => {
  const f = await fixture(t);
  await rm(f.packageRoot, { recursive: true });
  refusal(await resolveManual({ ...f.input, relevant: false }), "irrelevant");
  f.entry.enabled = false;
  await writeFile(f.registryPath, json(f.registry));
  refusal(await resolveManual(f.input), "disabled");
  assert.deepEqual((await health(f.input)).value, { canonical: "not-assessed", consent: "disabled", content: "not-assessed",
    contentFailure: undefined, binding: "manual-selection-only", delivery: "not-assessed", setupUpdate: "preserved", scope: f.scope });
});

test("exact profile, client, REA root and approved identity never fall back", async (t) => {
  const f = await fixture(t);
  for (const key of ["profileRoot", "reaRoot"]) refusal(await resolveManual({ ...f.input, scope: { ...f.scope, [key]: join(f.root, "other") } }), "binding");
  refusal(await resolveManual({ ...f.input, scope: { ...f.scope, client: "claude_code" } }), "binding");
  refusal(await resolveManual({ ...f.input, expectedIdentity: "0".repeat(64) }), "identity");
  refusal(await resolveManual({ ...f.input, id: "other" }), "not-registered");
  refusal(await resolveManual({ ...f.input, registryPath: join(f.root, "missing") }), "unreadable");
  refusal(await resolveManual({ ...f.input, path: "unlisted.md" }), "inventory");
});

test("registration defaults disabled, approval binds all bytes, and repeat/disable preserve intent", async (t) => {
  const f = await fixture(t);
  const original = json({ ...f.registry, entries: [] });
  const entry = { ...f.entry }; delete entry.enabled;
  const planned = await planRegistration({ registryBytes: original, scope: f.scope, entry });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  const approved = approvePlan(planned.value, original, planned.value.approvalDigest);
  assert.equal(JSON.parse(approved).entries[0].enabled, false);
  assert.throws(() => approvePlan(planned.value, original, "0".repeat(64)), /Approval/);
  assert.throws(() => approvePlan(planned.value, Buffer.from("changed"), planned.value.approvalDigest), /Approval/);
  assert.throws(() => approvePlan({ ...planned.value, registryText: "different" }, original, planned.value.approvalDigest), /Approval/);
  const repeat = await planRegistration({ registryBytes: approved, scope: f.scope, entry });
  assert.deepEqual(approvePlan(repeat.value, approved, repeat.value.approvalDigest), approved);
  const enabled = await planRegistration({ registryBytes: approved, scope: f.scope, entry: { ...entry, enabled: true } });
  assert.notEqual(enabled.value.approvalDigest, planned.value.approvalDigest);
  assert.equal(JSON.parse(approvePlan(enabled.value, approved, enabled.value.approvalDigest)).entries[0].enabled, true);
  await rm(f.packageRoot, { recursive: true });
  const disabled = await planDisable(json(f.registry), f.scope, "example");
  assert.equal(disabled.ok, true);
  assert.equal(JSON.parse(disabled.value.registryText).entries[0].enabled, false);
});

for (const failure of ["changed-manifest", "changed-file", "missing-file", "incompatible", "schema", "extra-field", "invalid-utf8", "newline-change"]) {
  test(`content refusal: ${failure} retains grant and no fallback`, async (t) => {
    const f = await fixture(t);
    if (failure === "changed-manifest") await writeFile(f.manifestPath, Buffer.concat([json(f.manifest), Buffer.from(" ")]));
    if (failure === "changed-file") await writeFile(join(f.packageRoot, "SKILL.md"), "changed");
    if (failure === "missing-file") await rm(join(f.packageRoot, "reference.md"));
    if (failure === "incompatible") { f.manifest.contract = "future-v2"; await f.save(); }
    if (failure === "schema") { f.manifest.schemaVersion = 2; await f.save(); }
    if (failure === "extra-field") { f.manifest.discoveryCommand = "do-not-run"; await f.save(); }
    if (failure === "invalid-utf8") { const bytes = Buffer.from([255]); await writeFile(join(f.packageRoot, "SKILL.md"), bytes); f.manifest.files["SKILL.md"] = digest(bytes); await f.save(); }
    if (failure === "newline-change") await writeFile(join(f.packageRoot, "SKILL.md"), f.skill.toString().replaceAll("\n", "\r\n"));
    const before = await readFile(f.registryPath);
    refusal(await resolveManual(f.input));
    assert.deepEqual(await readFile(f.registryPath), before);
    assert.equal((await health(f.input)).value.delivery, "not-assessed");
  });
}

for (const path of ["../escape", "/absolute", "C:/drive", "x\\backslash", "x:stream", "CON.md", "trailing.", "a//b", "./self", "caf\u00e9.md", "manifest.json"]) {
  test(`inventory refuses ${path}`, async (t) => {
    const f = await fixture(t); f.manifest.files[path] = "0".repeat(64); await f.save();
    refusal(await resolveManual(f.input), "inventory");
  });
}

test("case collisions, duplicate registrations, unknown registry and UNC are refused", async (t) => {
  const f = await fixture(t);
  f.manifest.files["skill.md"] = digest(f.skill); await f.save();
  refusal(await resolveManual(f.input), "inventory");
  delete f.manifest.files["skill.md"];
  f.manifest.files["A/one.md"] = "0".repeat(64); f.manifest.files["a/two.md"] = "0".repeat(64); await f.save();
  refusal(await resolveManual(f.input), "inventory");
  f.registry.entries.push({ ...f.entry }); await writeFile(f.registryPath, json(f.registry));
  refusal(await resolveManual(f.input), "collision");
  f.registry.schemaVersion = 9; await writeFile(f.registryPath, json(f.registry));
  const before = await readFile(f.registryPath);
  refusal(await resolveManual(f.input), "registry-schema");
  refusal(await planDisable(before, f.scope, "example"), "registry-schema");
  assert.deepEqual(await readFile(f.registryPath), before);
  refusal(await resolveManual({ ...f.input, registryPath: "\\\\untrusted-server\\share\\registry.json" }), "unsafe-path");
});

test("strict JSON rejects duplicate escaped keys, depth, UTF-8 and size", () => {
  assert.throws(() => strictJson(Buffer.from('{"id":1,"\\u0069d":2}')), /Duplicate/);
  assert.throws(() => strictJson(Buffer.from('{"outer":{"x":1,"x":2}}')), /Duplicate/);
  assert.throws(() => strictJson(Buffer.from("[".repeat(34) + "0" + "]".repeat(34))), /nesting/);
  assert.throws(() => strictJson(Buffer.alloc(LIMITS.json + 1, 32)), /byte limit/);
  assert.throws(() => strictJson(Buffer.from([255])));
  assert.deepEqual(strictJson(Buffer.from('{"a":[],"b":[{},true,null,1e4]}')), { a: [], b: [{}, true, null, 10000] });
});

test("oversized file and total inventory are rejected before instruction delivery", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(LIMITS.file + 1, 65);
  await writeFile(join(f.packageRoot, "SKILL.md"), bytes); f.manifest.files["SKILL.md"] = digest(bytes); await f.save();
  refusal(await resolveManual(f.input), "limit");
  const chunk = Buffer.alloc(LIMITS.file, 65);
  f.manifest.files = {};
  for (let i = 0; i < 5; i++) { const path = i === 0 ? "SKILL.md" : `file-${i}.md`; await writeFile(join(f.packageRoot, path), chunk); f.manifest.files[path] = digest(chunk); }
  await f.save(); refusal(await resolveManual(f.input), "limit");
});

test("hard links, junction parents, linked registry and directory files are rejected", async (t) => {
  const f = await fixture(t);
  await link(join(f.packageRoot, "SKILL.md"), join(f.root, "hard-link.md"));
  refusal(await resolveManual(f.input), "unsafe-path");
  await rm(join(f.root, "hard-link.md"));
  const junction = join(f.root, "redirect");
  await symlink(f.packageRoot, junction, process.platform === "win32" ? "junction" : "dir");
  f.entry.root = junction; await writeFile(f.registryPath, json(f.registry));
  refusal(await resolveManual(f.input), "unsafe-path");
  f.entry.root = f.packageRoot; await writeFile(f.registryPath, json(f.registry));
  await link(f.registryPath, join(f.root, "registry-alias.json"));
  refusal(await resolveManual(f.input), "unsafe-path");
  await rm(join(f.root, "registry-alias.json"));
  await rm(join(f.packageRoot, "SKILL.md")); await mkdir(join(f.packageRoot, "SKILL.md"));
  refusal(await resolveManual(f.input), "unsafe-path");
});

test("interrupted package update suspends old grant; new bytes cannot reuse old approval", async (t) => {
  const f = await fixture(t);
  const old = await readFile(f.registryPath);
  await writeFile(join(f.packageRoot, "reference.md"), "partial replacement");
  refusal(await resolveManual(f.input), "content-changed");
  assert.equal((await health(f.input)).value.content, "suspended");
  assert.deepEqual(await readFile(f.registryPath), old);
  f.manifest.files["reference.md"] = digest(Buffer.from("partial replacement")); await f.save();
  refusal(await resolveManual({ ...f.input, expectedIdentity: JSON.parse(old).entries[0].manifestDigest }), "identity");
});

const invalidMigrationStates = [
  ["null", null],
  ["empty array", []],
  ["array containing a valid-looking record", [{ fixtureSchema: 1, client: "codex" }]],
  ["true", true],
  ["false", false],
  ["number", 7],
  ["zero", 0],
  ["string", "codex"],
  ["empty string", ""],
  ["empty record", {}],
  ["missing schema", { client: "codex" }],
  ["unknown schema", { fixtureSchema: 2, client: "codex" }],
  ["zero schema", { fixtureSchema: 0, client: "codex" }],
  ["null schema", { fixtureSchema: null, client: "codex" }],
  ["string schema", { fixtureSchema: "1", client: "codex" }],
  ["missing client", { fixtureSchema: 1 }],
  ["unknown client", { fixtureSchema: 1, client: "unsupported" }],
  ["null client", { fixtureSchema: 1, client: null }],
  ["numeric client", { fixtureSchema: 1, client: 7 }],
  ["array client", { fixtureSchema: 1, client: ["codex"] }],
  ["object client", { fixtureSchema: 1, client: { name: "codex" } }],
];

for (const [name, state] of invalidMigrationStates) {
  test(`migration refuses malformed state: ${name}`, async () => {
    const block = (await readFile(new URL("./legacy-block.fixture.md", import.meta.url), "utf8")).replaceAll("\r\n", "\n").trimEnd();
    const reaBytes = Buffer.from(`Current REA header\n${block}\nCurrent REA references\n`);
    const stateBytes = json(state);
    const originalReaBytes = Buffer.from(reaBytes);
    const originalStateBytes = Buffer.from(stateBytes);
    const input = { reaBytes, stateBytes, expectedReaDigest: digest(reaBytes), expectedStateDigest: digest(stateBytes) };
    let result;
    assert.doesNotThrow(() => { result = planLegacyRemoval(input); });
    assert.equal(result.ok, false);
    assert.deepEqual(Object.keys(result).sort(), ["error", "ok"]);
    assert.equal(result.error.tag, "migration-refused");
    assert.equal(typeof result.error.detail, "string");
    assert.ok(result.error.detail.length > 0);
    assert.deepEqual(reaBytes, originalReaBytes, "Refusal must preserve current REA bytes");
    assert.deepEqual(stateBytes, originalStateBytes, "Refusal must preserve malformed state bytes");
  });
}

test("fixture migration preserves surrounding bytes, aliases, all state and disabled intent", async () => {
  const block = (await readFile(new URL("./legacy-block.fixture.md", import.meta.url), "utf8")).replaceAll("\r\n", "\n").trimEnd();
  for (const client of ["claude-code", "claude_code", "codex"]) for (const lineEnding of ["\n", "\r\n"]) {
    const prefix = Buffer.from("\ufeffNewer REA header\r\n"); const suffix = Buffer.from("\r\nNewer reference text\n");
    const reaBytes = Buffer.concat([prefix, Buffer.from(block.replaceAll("\n", lineEnding)), suffix]);
    const stateBytes = json({ fixtureSchema: 1, client, companionRoot: "custom/package", reaRoot: "custom/rea", weeklyOptIn: true,
      cooldown: 12345, enabled: false, backupPaths: ["retained"], pendingOffer: { id: "do-not-approve" }, unknownPreserved: 17 });
    const input = { reaBytes, stateBytes, expectedReaDigest: digest(reaBytes), expectedStateDigest: digest(stateBytes) };
    const result = planLegacyRemoval(input); assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.value.nextReaBytes, Buffer.concat([prefix, suffix]));
    assert.deepEqual(result.value.backupReaBytes, reaBytes); assert.deepEqual(result.value.nextStateBytes, stateBytes);
    assert.deepEqual(result.value.backupStateBytes, stateBytes); assert.equal(result.value.consent, "not-transferred");
    assert.equal(result.value.registration, "disabled-not-created");
    // No commit took place. An interrupted/stale fixture cannot reuse the plan.
    refusal(planLegacyRemoval({ ...input, reaBytes: Buffer.concat([reaBytes, Buffer.from("new edit")]) }));
    const customized = Buffer.from(reaBytes.toString().replace("cooperating instructions", "custom instructions"));
    refusal(planLegacyRemoval({ ...input, reaBytes: customized, expectedReaDigest: digest(customized) }));
    const duplicate = Buffer.concat([reaBytes, Buffer.from(block)]);
    refusal(planLegacyRemoval({ ...input, reaBytes: duplicate, expectedReaDigest: digest(duplicate) }));
  }
});
