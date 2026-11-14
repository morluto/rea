const allowedHostnames = () =>
  new Set([
    "localhost",
    "127.0.0.1",
    "::1",
    ...(process.env.STUDIO_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  ]);
export const isAllowedHost = (host: string | null): boolean =>
  host !== null &&
  allowedHostnames().has(
    host
      .toLowerCase()
      .replace(/:\d+$/, "")
      .replace(/^\[(.*)\]$/, "$1"),
  );
