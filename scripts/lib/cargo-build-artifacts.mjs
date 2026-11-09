/**
 * Select the one executable Cargo reported for a binary target.
 *
 * Cargo owns the output layout: CARGO_BUILD_TARGET, build.target and profile
 * settings all move the executable, so read its `compiler-artifact` messages
 * instead of reconstructing the path.
 */
export function cargoExecutableArtifact(messages, targetName) {
  const executables = [];
  for (const line of messages.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      continue;
    }
    if (
      message?.reason === "compiler-artifact" &&
      message.target?.name === targetName &&
      Array.isArray(message.target.kind) &&
      message.target.kind.includes("bin") &&
      typeof message.executable === "string"
    )
      executables.push(message.executable);
  }
  const unique = [...new Set(executables)];
  if (unique.length !== 1)
    throw new Error(
      unique.length === 0
        ? `Cargo reported no executable for binary target ${targetName}.`
        : `Cargo reported multiple executables for binary target ${targetName}: ${unique.join(", ")}`,
    );
  return unique[0];
}
