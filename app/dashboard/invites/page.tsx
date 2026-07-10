import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AUTH_COOKIE, getSession } from "@/lib/auth";
import { InvitesManager } from "@/components/InvitesManager";

// Invite management — ADMIN ONLY. The gate lives here (server side) as well as in
// the /api/admin/invites route: a presenter who navigates here is bounced to the
// dashboard rather than shown an admin surface they can't use. The API is the real
// boundary; this is the matching UI gate.
export const dynamic = "force-dynamic"; // reads the session cookie

export default async function InvitesPage() {
  const token = (await cookies()).get(AUTH_COOKIE)?.value;
  const session = getSession(token);
  if (!session) redirect("/login");
  if (session.role !== "admin") redirect("/dashboard");
  return <InvitesManager />;
}
