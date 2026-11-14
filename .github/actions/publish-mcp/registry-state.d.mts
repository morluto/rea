export type RegistryReadFailureKind =
  | "timeout"
  | "network_error"
  | "server_error"
  | "not_found"
  | "http_error"
  | "other";

export function classifyReadFailure(error: unknown): RegistryReadFailureKind;

export function registryPublicationState(
  server: Readonly<{ name: string; version: string } & Record<string, unknown>>,
  request?: (url: URL, init: RequestInit) => Promise<Response>,
  options?: {
    retryDelaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<"present" | "absent">;
