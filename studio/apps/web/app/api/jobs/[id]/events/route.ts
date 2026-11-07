import { getStore, guard, notFoundJson } from "@/lib/server";

export const dynamic = "force-dynamic";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const POLL_MS = 700;

/** Server-sent events: stored job events after `after`, plus status changes. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const refused = guard(request);
  if (refused) return refused;
  const { id } = await params;
  const store = getStore();
  if (!store.getJob(id)) return notFoundJson();
  const url = new URL(request.url);
  let after =
    Number(
      request.headers.get("last-event-id") ??
        url.searchParams.get("after") ??
        0,
    ) || 0;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown, eventId?: number) => {
        controller.enqueue(
          encoder.encode(
            `${eventId === undefined ? "" : `id: ${eventId}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
          ),
        );
      };
      let lastStatus = "";
      try {
        while (!request.signal.aborted) {
          const events = store.listEvents(id, after);
          for (const stored of events) {
            send("job", stored, stored.seq);
            after = stored.seq;
          }
          const job = store.getJob(id);
          if (!job) break;
          const status = JSON.stringify([
            job.status,
            job.usage,
            job.error ?? null,
          ]);
          if (status !== lastStatus) {
            lastStatus = status;
            send("status", {
              status: job.status,
              usage: job.usage,
              error: job.error ?? null,
            });
          }
          if (TERMINAL.has(job.status) && events.length === 0) {
            send("end", { status: job.status });
            break;
          }
          await new Promise((done) => setTimeout(done, POLL_MS));
        }
      } catch {
        // The client went away.
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
