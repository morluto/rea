/**
 * The Windows system root for a Node child started through REA's owned Windows
 * launcher. That launcher passes the environment block exactly as given, and a
 * Node child without SystemRoot aborts while seeding its random number
 * generator, before the test script runs. Other platforms need nothing here.
 */
export const windowsSystemRootEnvironment = (): NodeJS.ProcessEnv =>
  process.platform === "win32" && process.env.SystemRoot !== undefined
    ? { SystemRoot: process.env.SystemRoot }
    : {};
