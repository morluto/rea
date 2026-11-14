import { notFound } from "next/navigation";
import { ProjectDetail } from "@/components/Projects";
import { getStore } from "@/lib/server";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const store = getStore();
  const project = store.getProject(id);
  if (!project) notFound();
  return (
    <ProjectDetail
      project={project}
      model={store.getModel(project.modelId)}
      jobs={store.listJobs(-1).filter((job) => job.projectId === id)}
    />
  );
}
