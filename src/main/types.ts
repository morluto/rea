export interface RuntimeDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly serve: typeof import("@modelcontextprotocol/server/stdio").serveStdio;
  readonly writeStderr: (text: string) => void;
  readonly setExitCode: (code: number) => void;
  readonly registerShutdown: (handler: () => void) => () => void;
  readonly registerReload?: (handler: () => void) => () => void;
  readonly createServer?: typeof import("../server/createServer.js").createServer;
  readonly readProjectPermissionStore?: typeof import("../application/ProjectPermissionStore.js").readProjectPermissionStore;
}
