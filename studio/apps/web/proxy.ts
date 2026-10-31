import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { isAllowedHost } from "./lib/request-policy";
const COOKIE = "reall-session";
export function proxy(request: NextRequest) {
  if (!isAllowedHost(request.headers.get("host")))
    return new NextResponse("Host not allowed", { status: 403 });
  const token = process.env.STUDIO_SESSION_TOKEN;
  if (!token)
    return new NextResponse("Start Reall with npm run dev or npm run studio.", {
      status: 503,
    });
  const received = Buffer.from(request.cookies.get(COOKIE)?.value ?? "");
  const expected = Buffer.from(token);
  const authenticated =
    received.length === expected.length && timingSafeEqual(received, expected);
  if (request.nextUrl.pathname.startsWith("/api/") && !authenticated)
    return NextResponse.json(
      { error: "Open Reall in this browser to start a local session." },
      { status: 401 },
    );
  if (
    request.headers.get("sec-fetch-site") === "cross-site" &&
    request.nextUrl.pathname.startsWith("/api/")
  )
    return NextResponse.json(
      { error: "Cross-site requests are refused." },
      { status: 403 },
    );
  const response = NextResponse.next();
  if (!authenticated)
    response.cookies.set(COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      secure: request.nextUrl.protocol === "https:",
    });
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "same-origin");
  return response;
}
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
