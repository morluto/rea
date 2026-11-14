import { redirect } from "next/navigation";
import { JobWizard } from "@/components/JobWizard";
import { getStore, workerHeartbeat } from "@/lib/server";
export const dynamic = "force-dynamic";
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project: id } = await searchParams;
  const store = getStore();
  const project = id ? store.getProject(id) : undefined;
  if (!project) redirect("/projects/new");
  const heartbeat = workerHeartbeat();
  return (
    <JobWizard
      project={project}
      models={store.listModels()}
      settings={store.getSettings()}
      workerAlive={Boolean(
        heartbeat && Date.now() - heartbeat.getTime() < 15000,
      )}
    />
  );
}
