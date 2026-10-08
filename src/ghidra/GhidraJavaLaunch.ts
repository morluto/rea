import { dirname, join } from "node:path";
import { execFileOutput } from "../process/ExecFileOutput.js";

/** Launch coordinates obtained from Ghidra's own release configuration helper. */
export const ghidraJavaLaunch = async (options: {
  readonly analyzeHeadlessPath: string;
  readonly javaHome: string;
  readonly homeRoot: string;
  readonly tempRoot: string;
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly command: string;
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}> => {
  const supportRoot = dirname(options.analyzeHeadlessPath);
  const installRoot = dirname(supportRoot);
  const command = join(options.javaHome, "bin", "java");
  const isolatedProperties = [
    `-Duser.home=${options.homeRoot}`,
    `-Djava.io.tmpdir=${options.tempRoot}`,
  ];
  const supportArguments = [
    ...isolatedProperties,
    "-cp",
    join(supportRoot, "LaunchSupport.jar"),
    "LaunchSupport",
    installRoot,
  ];
  const environment = { ...options.environment };
  const configuredEnvironment = await execFileOutput(
    command,
    [...supportArguments, "-envvars"],
    {
      env: environment,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  for (const line of configuredEnvironment.stdout.split(/\r?\n/u)) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
      throw new Error(
        `Invalid Ghidra LaunchSupport environment entry: ${line}`,
      );
    if ((environment[key] ?? "") === "")
      environment[key] = line.slice(separator + 1);
  }
  const configuredArguments = await execFileOutput(
    command,
    [...supportArguments, "-vmargs"],
    {
      env: environment,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  const vmArguments = configuredArguments.stdout
    .split(/\r?\n/u)
    .filter((line) => line !== "");
  if (
    vmArguments.some(
      (argument) => !argument.startsWith("-") || argument.includes("\0"),
    )
  )
    throw new Error("Invalid Ghidra LaunchSupport JVM argument");
  return {
    command,
    environment,
    arguments: [
      ...vmArguments,
      "-Xdock:name=Ghidra-Headless",
      `-Xmx${environment.GHIDRA_HEADLESS_MAXMEM || environment.GHIDRA_MAXMEM || "2G"}`,
      "-XX:ParallelGCThreads=2",
      "-XX:CICompilerCount=2",
      "-Djava.awt.headless=true",
      ...isolatedProperties,
      "-showversion",
      "-cp",
      join(installRoot, "Ghidra", "Framework", "Utility", "lib", "Utility.jar"),
      "ghidra.Ghidra",
      "ghidra.app.util.headless.AnalyzeHeadless",
      ...options.arguments,
    ],
  };
};
