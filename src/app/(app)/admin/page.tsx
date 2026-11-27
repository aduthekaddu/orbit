import { AdminForm } from "@/components/admin/admin-form";
import { toPublicInstance } from "@/lib/instance-settings";
import { requireAdminPage } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const { user } = await requireAdminPage();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto flex w-full max-w-page flex-col gap-6 px-4 pt-6 pb-10 sm:px-6 sm:pt-10">
        <h1 className="text-xl font-semibold tracking-tight">Admin</h1>
        <AdminForm initial={toPublicInstance(user.id)} />
      </div>
    </div>
  );
}
