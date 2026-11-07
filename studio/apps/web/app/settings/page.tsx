import { Settings } from "@/components/Settings";
import { getStore } from "@/lib/server";
export const dynamic = "force-dynamic";
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const store = getStore();
  const returnToProject = (await searchParams).returnTo === "project";
  return (
    <Settings
      initialConnections={store.listConnections()}
      initialModels={store.listModels()}
      initialSettings={store.getSettings()}
      returnToProject={returnToProject}
    />
  );
}
