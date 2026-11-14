import { guard } from "@/lib/server";
import { usageSnapshot } from "@/lib/usage";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const refused = guard(request);
  if (refused) return refused;
  const projectId = new URL(request.url).searchParams.get("project") ?? "";
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (timer) clearInterval(timer);
  };
  const stream = new ReadableStream({
    start(controller) {
      const send = () => {
        try {
          controller.enqueue(
            new TextEncoder().encode(
              `event: usage\ndata: ${JSON.stringify(usageSnapshot(projectId))}\n\n`,
            ),
          );
        } catch {
          stop();
        }
      };
      send();
      timer = setInterval(send, 2000);
      request.signal.addEventListener(
        "abort",
        () => {
          stop();
          try {
            controller.close();
          } catch {
            /* disconnected */
          }
        },
        { once: true },
      );
    },
    cancel: stop,
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
