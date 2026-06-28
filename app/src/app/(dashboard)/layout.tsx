import { Sidebar } from "@/components/sidebar";
import { ConfigGuard } from "@/components/config-guard";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-svh w-full">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="page-fade flex flex-1 flex-col overflow-y-auto">
          <ConfigGuard>{children}</ConfigGuard>
        </div>
      </div>
    </div>
  );
}
