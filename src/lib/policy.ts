import { z } from "zod";

const viewerSchema = z.object({ id: z.string().min(1).brand<"UserId">(), role: z.enum(["admin", "member"]) });
export type Viewer = z.infer<typeof viewerSchema>;
export type UserId = Viewer["id"];
export type Role = Viewer["role"];

export function parseViewer(input: unknown): Viewer {
  return viewerSchema.parse(input);
}

export type HostingMode = { kind: "personal" };
type SignupDecision = { ok: true; role: Role; invite: "keep" } | { ok: false; reason: "closed" };

type Policy = {
  signup(input: { accounts: number; invite: "none" | "valid" | "invalid" }): SignupDecision;
  openWithoutInvite(accounts: number): boolean;
  mayInvite(viewer: Viewer): boolean;
  mayCreateConnection(viewer: Viewer): boolean;
  connectionOwner(viewer: Viewer, adminId?: UserId): UserId;
  guardsPrivateHosts: boolean;
};

export function parseHostingMode(value: unknown): HostingMode {
  if (value !== "personal") throw new Error("Invalid hosting mode in instance settings.");
  return { kind: value };
}

export function policyFor(mode: HostingMode): Policy {
  switch (mode.kind) {
    case "personal":
      return {
        signup: ({ accounts }) => accounts === 0 ? { ok: true, role: "admin", invite: "keep" } : { ok: false, reason: "closed" },
        openWithoutInvite: (accounts) => accounts === 0,
        mayInvite: () => false,
        mayCreateConnection: (viewer) => viewer.role === "admin",
        connectionOwner: (viewer) => viewer.id,
        guardsPrivateHosts: false,
      };
  }
}
