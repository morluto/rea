import { getStore, workerHeartbeat } from "./server";
export function usageSnapshot(projectId = "") {
  const store = getStore();
  const jobs = store
    .listJobs(-1)
    .filter((job) => !projectId || job.projectId === projectId);
  const totals = jobs.reduce(
    (sum, job) => ({
      input: sum.input + job.usage.inputTokens,
      output: sum.output + job.usage.outputTokens,
      tokens: sum.tokens + job.usage.totalTokens,
      cost: sum.cost + (job.usage.estimatedCostUsd ?? 0),
      unpriced:
        sum.unpriced +
        (job.usage.unpricedTokens ??
          (job.usage.estimatedCostUsd === undefined
            ? job.usage.totalTokens
            : 0)),
    }),
    { input: 0, output: 0, tokens: 0, cost: 0, unpriced: 0 },
  );
  const daily = Array.from({ length: 14 }, (_, index) => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - 13 + index);
    return { date: date.toISOString().slice(0, 10), input: 0, output: 0 };
  });
  const rows = store.db
    .prepare(
      "SELECT substr(ts, 1, 10) AS day, SUM(COALESCE(json_extract(data_json, '$.stepInputTokens'), 0)) AS input, SUM(COALESCE(json_extract(data_json, '$.stepOutputTokens'), 0)) AS output FROM job_events WHERE json_extract(data_json, '$.type') = 'usage' AND ts >= ? AND (? = '' OR job_id IN (SELECT id FROM jobs WHERE project_id = ?)) GROUP BY day",
    )
    .all(daily[0]!.date, projectId, projectId);
  for (const row of rows) {
    const day = daily.find((item) => item.date === row.day);
    if (day) {
      day.input = Number(row.input);
      day.output = Number(row.output);
    }
  }
  const heartbeat = workerHeartbeat();
  return {
    totals,
    daily,
    jobs: jobs.slice(0, 30),
    jobCount: jobs.length,
    active: jobs.filter((job) =>
      ["queued", "running", "waiting_approval"].includes(job.status),
    ).length,
    projects: store.listProjects(),
    models: store.listModels(),
    workerAlive: Boolean(heartbeat && Date.now() - heartbeat.getTime() < 15000),
    timestamp: new Date().toISOString(),
    projectId,
  };
}
export type UsageSnapshot = ReturnType<typeof usageSnapshot>;
