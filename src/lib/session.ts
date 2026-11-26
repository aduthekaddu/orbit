import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "./auth";

export const getSession = cache(async () =>
  getAuth().api.getSession({ headers: await headers(), query: { disableRefresh: true } }),
);

export async function requireUser() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

export function unauthorized() {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
