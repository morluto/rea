// Value-only migration experiment. The companion installer remains the proposed
// writer/backup owner. This module never reads or writes an installation.
import { digest, strictJson, LIMITS } from "./resolver.mjs";

const BEGIN = Buffer.from("<!-- rea-reconstruction-companion:begin -->");
const END = Buffer.from("<!-- rea-reconstruction-companion:end -->");
// Exact LF / CRLF block bytes, excluding its final line ending, from companion
// integration/rea-companion.md at 4fff7d77163c0c153e3bb247c2f04c5a594ed447.
const KNOWN_BLOCKS = new Set([
  "05a004516a081cec5e92d2b2d1478dbd1dd10d88d54f93a7faad8d1d20c3591a",
  "df90776da82b6fecb5ef2be667e489f232332c2f45405996b1a6749aa8b2eacc",
]);

export function planLegacyRemoval(input) {
  const refuse = (detail) => ({ ok: false, error: { tag: "migration-refused", detail } });
  const { reaBytes, stateBytes, expectedReaDigest, expectedStateDigest } = input;
  if (reaBytes.length > LIMITS.total || stateBytes.length > LIMITS.json) return refuse("Input exceeds fixture bounds");
  if (digest(reaBytes) !== expectedReaDigest || digest(stateBytes) !== expectedStateDigest) return refuse("Current bytes differ from reviewed inputs");
  // Parse only to reject malformed/unknown state; preserve ALL original bytes.
  // This is a named fixture state, not the released updater's production schema.
  let state;
  try { state = strictJson(stateBytes); } catch { return refuse("State is invalid"); }
  if (state === null || typeof state !== "object" || Array.isArray(state)) return refuse("State must be a non-null record");
  if (state.fixtureSchema !== 1 || !["claude-code", "claude_code", "codex"].includes(state.client)) return refuse("Unknown fixture schema or client");
  const begin = reaBytes.indexOf(BEGIN);
  const end = reaBytes.indexOf(END);
  if (begin < 0 || end < begin || reaBytes.indexOf(BEGIN, begin + 1) !== -1 || reaBytes.indexOf(END, end + 1) !== -1) return refuse("Missing, malformed or duplicate block");
  const after = end + END.length;
  if (!KNOWN_BLOCKS.has(digest(reaBytes.subarray(begin, after)))) return refuse("Customized or unrecognized block");
  const next = Buffer.concat([reaBytes.subarray(0, begin), reaBytes.subarray(after)]);
  return { ok: true, value: {
    priorReaDigest: digest(reaBytes), nextReaBytes: next,
    // Backups are complete current inputs; rollback must compare current bytes
    // with the written result before restoring. No stale whole-file restore.
    backupReaBytes: Buffer.from(reaBytes), backupStateBytes: Buffer.from(stateBytes),
    nextStateBytes: Buffer.from(stateBytes), registration: "disabled-not-created",
    canonical: "not-assessed", binding: "not-assessed", consent: "not-transferred",
    pendingDecision: "preserved-reassessment-required", delivery: "inactive",
  } };
}
