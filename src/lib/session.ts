import { cache } from "react";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getAuth } from "./auth";

import { parseViewer } from "./policy";
export { parseViewer, type UserId, type Role, type Viewer } from "./policy";

async function readSession(headers: Headers) {
  const session = await getAuth().api.getSession({ headers, query: { disableRefresh: true } });
  if (!session) return null;
  return { ...session, user: { ...session.user, ...parseViewer(session.user) } };
}

export const getSession = cache(async () => readSession(await headers()));

export function sessionFrom(request: Request) {
  return readSession(request.headers);
}

export async function requireUser() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

export function unauthorized() {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

export async function adminFrom(request: Request) {
  const session = await sessionFrom(request);
  if (!session) return { ok: false, response: unauthorized() } as const;
  if (session.user.role !== "admin") {
    return { ok: false, response: Response.json({ error: "Forbidden" }, { status: 403 }) } as const;
  }
  return { ok: true, session } as const;
}

export async function requireAdminPage() {
  const session = await requireUser();
  if (session.user.role !== "admin") notFound();
  return session;
}
