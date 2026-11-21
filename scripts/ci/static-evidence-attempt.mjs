/** Static-check artifacts are published for the first attempt only. */
export function isStaticEvidenceAttempt(runAttempt) {
  return runAttempt === 1;
}
