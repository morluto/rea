export function registryPublicationState(
  server: Readonly<{ name: string; version: string } & Record<string, unknown>>,
  request?: (url: URL, init: RequestInit) => Promise<Response>,
): Promise<"present" | "absent">;
