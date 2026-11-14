#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveReaLaunch } from "@rea-studio/agent";
import { studioHome, StudioStore } from "@rea-studio/core";

import { processJob } from "./runner.js";

const IDLE_MS = 2_000;
const concurrency = Math.max(1, Number(process.env.STUDIO_WORKER_CONCURRENCY ?? 1));

const heartbeatPath = join(studioHome(), "worker.heartbeat");
const beat = () => writeFileSync(heartbeatPath, new Date().toISOString());

const log = (message: string) =>
  process.stdout.write(`${new Date().toISOString()} [worker] ${message}\n`);

const store = new StudioStore();
const shutdown = new AbortController();
const running = new Set<Promise<unknown>>();

const interrupted = store.failInterruptedJobs();
if (interrupted > 0) log(`Marked ${interrupted} interrupted job(s) as failed.`);
const launch = resolveReaLaunch();
log(`REA launch: ${launch.source} → ${launch.command} ${launch.args.join(" ")}`);
log(`Waiting for jobs (concurrency ${concurrency}).`);

const stop = () => {
  if (shutdown.signal.aborted) return;
  log("Stopping; running jobs are being cancelled.");
  shutdown.abort(new Error("Worker shutting down."));
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

while (!shutdown.signal.aborted) {
  beat();
  if (running.size < concurrency) {
    const job = store.claimNextJob();
    if (job) {
      log(`Starting job ${job.id}: ${job.title}`);
      const task = processJob(store, job, { shutdown: shutdown.signal })
        .then((result) => log(`Job ${job.id} ${result.status}${result.error ? `: ${result.error}` : ""}`))
        .finally(() => running.delete(task));
      running.add(task);
      continue;
    }
  }
  await new Promise((done) => setTimeout(done, IDLE_MS));
}

await Promise.allSettled([...running]);
store.close();
