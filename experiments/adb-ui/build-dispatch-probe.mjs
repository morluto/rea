import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { output: { type: "string" } } });
if (!values.output) throw new Error("Missing --output");
const output = resolve(values.output);
await mkdir(output, { mode: 0o700 });
const project = join(output, "project");
await cp(resolve(import.meta.dirname, "../../bridge/adb-ui"), project, {
  recursive: true,
  errorOnExist: true,
  force: false,
  dereference: true,
  filter: (path) => ![".gradle", "build"].includes(basename(path)),
});
const runner = join(
  project,
  "src/main/java/dev/rea/uiautomator/ReaUiRunner.java",
);
const original = await readFile(runner, "utf8");
let source = original;
// Bind injection to each input's final cancellation checkpoint, not to the
// signature or diagnostic text of an earlier preparation helper. Whitespace
// changes are immaterial; missing or ambiguous dispatch guards still fail closed.
const guards = [
  {
    action: "drag",
    pattern:
      /^([ \t]*)call\.check\(\);\s+attempted\s*=\s*true;\s+selected\.object\.drag\(center\);/gmu,
  },
  {
    action: "key_event",
    pattern:
      /^([ \t]*)call\.check\(\);\s+attempted\s*=\s*true;\s+if\s*\(!device\.pressKeyCode\(/gmu,
  },
];
const anchors = [];
for (const { action, pattern } of guards) {
  const matches = [...source.matchAll(pattern)];
  assert.equal(
    matches.length,
    1,
    `Expected one final dispatch guard for ${action}`,
  );
  const [match] = matches;
  const [anchor, indent] = match;
  anchors.push({ action, source: anchor });
  source =
    source.slice(0, match.index) +
    `${indent}// Verification-only state injection after the real preparation reads.
${indent}if (input.getInt("timeout_ms") == 11001) call.cancelled = true;
${indent}if (input.getInt("timeout_ms") == 11002) call.deadline = 0;
${anchor}` +
    source.slice(match.index + anchor.length);
}
// Mask only the key admission read, leaving the actual window selection,
// captured identity and active state intact. This is a controlled producer
// fault, not a reproduction of Android's touch-exploration focus routing.
const focusPattern =
  /(for\s*\(UiWindow window : device\.findWindows\(keyScope\)\)\s*\{\s*if\s*\(!)(window\.isFocused\(\))/gu;
const focusReads = [...source.matchAll(focusPattern)];
assert.equal(
  focusReads.length,
  1,
  "Expected one key-admission input-focus read",
);
const [focusRead] = focusReads;
const [focusAnchor, focusPrefix, focusGetter] = focusRead;
source =
  source.slice(0, focusRead.index) +
  `${focusPrefix}(input.getInt("timeout_ms") != 11003 && ${focusGetter})` +
  source.slice(focusRead.index + focusAnchor.length);
await writeFile(runner, source);
const gradle = join(project, "build.gradle");
await writeFile(
  gradle,
  `${await readFile(gradle, "utf8")}\nandroid.defaultConfig.versionName = 'dispatch-guard-probe'\n`,
);
await writeFile(
  join(output, "probe.json"),
  JSON.stringify(
    {
      purpose:
        "Controlled key/drag dispatch interruptions and a masked key-admission input-focus read",
      source_sha256: createHash("sha256").update(original).digest("hex"),
      probe_sha256: createHash("sha256").update(source).digest("hex"),
      anchors,
      input_focus_anchor: focusAnchor,
      modes: {
        10000: "unchanged control",
        11001: "cancelled",
        11002: "expired",
        11003:
          "key window input focus masked false; real active state unchanged",
      },
      project,
    },
    null,
    2,
  ),
  { flag: "wx" },
);
console.log(project);
