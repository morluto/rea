import { Dashboard } from "@/components/Dashboard";
import { usageSnapshot } from "@/lib/usage";
export const dynamic = "force-dynamic";
export default function Page() {
  return <Dashboard initial={usageSnapshot()} />;
}
