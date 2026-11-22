import { sep } from "node:path";

/**
 * Verify the native activation's verbatim instructions and resource tree root.
 * @param {readonly {name?: string, response?: {output?: unknown}}[]} responses
 * @param {string} directory
 * @param {string} body
 */
export function hasGeminiSkillBody(responses, directory, body) {
  const start = `<activated_skill name="reverse-engineer-anything">\n  <instructions>\n    ${body}\n  </instructions>\n\n  <available_resources>\n    `;
  return responses.some(({ name, response }) => {
    const output = response?.output;
    if (name !== "activate_skill" || typeof output !== "string") return false;
    const at = output.indexOf(start);
    if (at < 0) return false;
    const first = at + start.length;
    const last = output.indexOf(
      "\n  </available_resources>\n</activated_skill>",
      first,
    );
    if (last < 0) return false;
    const resources = output.slice(first, last);
    const [, blank, root] = resources.split("\n", 3);
    return (
      !resources.includes("</activated_skill>") &&
      !resources.includes("</available_resources>") &&
      blank === "" &&
      root === directory + sep
    );
  });
}

/**
 * Gemini streams assistant text as message chunks. Only the final answer after
 * any tool exchange, followed by a successful terminal result, proves delivery.
 * @param {string} stdout
 * @param {string} expected
 */
export function hasGeminiFinalAnswer(stdout, expected) {
  const events = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const result = events.pop();
  if (result?.type !== "result" || result.status !== "success") return false;
  /** @type {string[]} */
  let answer = [];
  for (const event of events) {
    if (event?.type === "result") return false;
    if (
      event?.type === "tool_use" ||
      event?.type === "tool_result" ||
      (event?.type === "message" && event.role === "user")
    )
      answer = [];
    if (event?.type === "message" && event.role === "assistant") {
      if (typeof event.content !== "string") return false;
      answer.push(event.content);
    }
  }
  return answer.join("") === expected;
}
