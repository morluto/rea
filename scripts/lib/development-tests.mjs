const sourceProjects = [
  "domain",
  "services",
  "adapters",
  "composition",
  "conformance",
  "evaluation",
];

const sourceTest = (path) =>
  path.startsWith("src/") ||
  ["composition", "conformance", "evaluation"].some((project) =>
    path.startsWith(`tests/${project}/`),
  );

/** Parse explicit test paths and an optional branch-comparison base. */
export const parseDevelopmentTestRequest = (mode, arguments_) => {
  if (!["local", "changed", "focused"].includes(mode))
    throw new Error("Expected local, changed, or focused test mode");
  const paths = [];
  let base = "origin/main";
  let dryRun = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--dry-run") dryRun = true;
    else if (argument === "--base" || argument.startsWith("--base=")) {
      if (mode !== "changed") throw new Error("--base requires changed mode");
      base = argument === "--base" ? arguments_[++index] : argument.slice(7);
      if (!base || base.startsWith("-") || base.includes("\0"))
        throw new Error("--base requires a Git revision");
    } else {
      const path = argument.replaceAll("\\", "/").replace(/^\.\//u, "");
      if (
        !/^(?:src|tests)\/.+\.test\.ts$/u.test(path) ||
        path.split("/").some((part) => part === ".." || part === ".")
      )
        throw new Error(`Expected an exact repository test path: ${argument}`);
      if (mode !== "focused" && !sourceTest(path))
        throw new Error(
          `Use test:focused for compiled boundary tests: ${path}`,
        );
      paths.push(path);
    }
  }
  if (mode === "focused" && paths.length === 0)
    throw new Error("test:focused requires at least one exact test path");
  if (mode === "changed" && paths.length > 0)
    throw new Error("Use test:focused for explicit test paths");
  return { mode, paths: [...new Set(paths)], base, dryRun };
};

/** Plan source feedback or a strict explicit run with its build prerequisite. */
export const developmentTestPlan = (request, baseCommit) => {
  const explicit = request.paths.length > 0;
  if (
    request.mode === "changed" &&
    !/^[a-f0-9]{40,64}$/u.test(baseCommit ?? "")
  )
    throw new Error("Changed tests require a resolved Git merge base");
  const projects = request.mode === "focused" ? [] : sourceProjects;
  return {
    needsBuild: request.paths.some((path) => !sourceTest(path)),
    vitestArguments: [
      "run",
      ...projects.flatMap((project) => ["--project", project]),
      ...(explicit
        ? request.paths
        : [
            request.mode === "changed"
              ? `--changed=${baseCommit}`
              : "--changed",
            "--passWithNoTests",
          ]),
    ],
  };
};
