import { ProjectForm } from "@/components/ProjectForm";
import { getStore } from "@/lib/server";
export const dynamic = "force-dynamic";
export default function Page() {
  const store = getStore();
  return (
    <ProjectForm
      connections={store.listConnections()}
      models={store.listModels()}
      settings={store.getSettings()}
    />
  );
}
