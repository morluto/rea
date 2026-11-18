// Counts hand-read abort checks on a completed Result (`result.ok && ...`).
// A negated check (`!outcome.ok && signal?.aborted`) examines a failed primary
// to attach a secondary cancellation, not a completed result.
const completedAbortReclassification =
  /(?<!(?<![!=])!\s*[A-Za-z_$][\w$.?#]*(?:\([^()\n]*\))?)\.ok\s*&&\s*(?:isAborted\(|[\w.?]*signal\??\.aborted)/gu;

/** @param {string} content */
export const completedAbortReclassificationCount = (content) =>
  content.match(completedAbortReclassification)?.length ?? 0;
