/**
 * The headless JSON stream ends with one final event carrying the exact answer.
 * @param {string} stdout
 * @param {string} expected
 */
export function hasDeepSeekFinalEvent(stdout, expected) {
  let start = 0;
  while (start < stdout.length) {
    const end = stdout.indexOf("\n", start);
    if (end === -1) return false;
    let event;
    try {
      event = JSON.parse(stdout.slice(start, end));
    } catch {
      return false;
    }
    if (typeof event?.type !== "string") return false;
    if (event.type === "final")
      return end + 1 === stdout.length && event.text === expected;
    start = end + 1;
  }
  return false;
}

/**
 * Check the installed skill in one native model-facing tool message. The
 * directory hint is escaped by Harness, while the instruction body is verbatim.
 * @param {readonly { readonly content?: unknown }[]} messages
 * @param {string} directory
 * @param {string} body
 */
export function hasDeepSeekSkillBody(messages, directory, body) {
  const escapedDirectory = directory
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const base = `Base directory for this skill: ${escapedDirectory}`;
  const open =
    '<skill_content name="reverse-engineer-anything">\n<skill_resources>\n';
  const instructions = `\n</skill_resources>\n\n<skill_instructions>\n${body}\n</skill_instructions>\n</skill_content>`;
  return messages.some(({ content }) => {
    if (typeof content !== "string") return false;
    const start = content.indexOf(open);
    if (start < 0) return false;
    const resourcesStart = start + open.length;
    const resourcesEnd = content.indexOf(instructions, resourcesStart);
    if (resourcesEnd < 0) return false;
    const resources = content.slice(resourcesStart, resourcesEnd);
    return (
      !resources.includes("</skill_content>") &&
      !resources.includes("</skill_resources>") &&
      resources.split("\n").includes(base)
    );
  });
}
