import { Projects } from "@/components/Projects";
import { getStore } from "@/lib/server";
export const dynamic = "force-dynamic";
export default function Page() {
  const store = getStore();
  return (
    <Projects
      projects={store.listProjects()}
      jobs={store.listJobs(-1)}
      models={store.listModels()}
    />
  );
}
