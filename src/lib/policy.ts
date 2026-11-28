import { z } from "zod";

const viewerSchema = z.object({ id: z.string().min(1).brand<"UserId">(), role: z.enum(["admin", "member"]) });
export type Viewer = z.infer<typeof viewerSchema>;
export type UserId = Viewer["id"];
export type Role = Viewer["role"];

export function parseViewer(input: unknown): Viewer {
  return viewerSchema.parse(input);
}

export const HOSTING_MODES = ["personal", "team", "community"] as const;
export const SIGNUP_MODES = ["invite", "open"] as const;

export type SignupMode = (typeof SIGNUP_MODES)[number];
export type HostingMode =
  | { kind: "personal" }
  | { kind: "team" }
  | { kind: "community"; signup: SignupMode };

type InviteCheck = "none" | "valid" | "invalid";
type SignupDecision =
  | { ok: true; role: Role; invite: "consume" | "keep" }
  | { ok: false; reason: "closed" | "invite-required" | "invite-invalid" };

type Policy = {
  signup(input: { accounts: number; invite: InviteCheck }): SignupDecision;
  openWithoutInvite(accounts: number): boolean;
  mayInvite(viewer: Viewer): boolean;
  mayCreateConnection(viewer: Viewer): boolean;
  connectionOwner(viewer: Viewer, adminId?: UserId): UserId;
  guardsPrivateHosts: boolean;
};

type ModeSwitch =
  | { ok: true; deletePendingInvites: boolean; resetSignupMode: boolean }
  | { ok: false; reason: "accounts-exist" };

export function parseHostingMode(value: unknown, signup: unknown = "invite"): HostingMode {
  const mode = z.enum(HOSTING_MODES).safeParse(value);
  if (!mode.success) throw new Error("Invalid hosting mode in instance settings.");
  const signupMode = z.enum(SIGNUP_MODES).safeParse(signup);
  if (!signupMode.success) throw new Error("Invalid signup mode in instance settings.");
  return mode.data === "community" ? { kind: mode.data, signup: signupMode.data } : { kind: mode.data };
}

const firstAccount: SignupDecision = { ok: true, role: "admin", invite: "keep" };
const isAdmin = (viewer: Viewer) => viewer.role === "admin";
const ownConnections = (viewer: Viewer) => viewer.id;

function memberSignup(accounts: number, invite: InviteCheck, open: boolean): SignupDecision {
  if (accounts === 0) return firstAccount;
  switch (invite) {
    case "invalid": return { ok: false, reason: "invite-invalid" };
    case "valid": return { ok: true, role: "member", invite: "consume" };
    case "none":
      return open ? { ok: true, role: "member", invite: "keep" } : { ok: false, reason: "invite-required" };
  }
}

export function policyFor(mode: HostingMode): Policy {
  switch (mode.kind) {
    case "personal":
      return {
        signup: ({ accounts }) => accounts === 0 ? firstAccount : { ok: false, reason: "closed" },
        openWithoutInvite: (accounts) => accounts === 0,
        mayInvite: () => false,
        mayCreateConnection: isAdmin,
        connectionOwner: ownConnections,
        guardsPrivateHosts: false,
      };
    case "team":
      return {
        signup: ({ accounts, invite }) => memberSignup(accounts, invite, false),
        openWithoutInvite: (accounts) => accounts === 0,
        mayInvite: isAdmin,
        mayCreateConnection: isAdmin,
        connectionOwner: (viewer, adminId) => {
          if (isAdmin(viewer)) return viewer.id;
          if (!adminId) throw new Error("Team mode requires an admin account.");
          return adminId;
        },
        guardsPrivateHosts: false,
      };
    case "community": {
      const open = mode.signup === "open";
      return {
        signup: ({ accounts, invite }) => memberSignup(accounts, invite, open),
        openWithoutInvite: (accounts) => open || accounts === 0,
        mayInvite: isAdmin,
        mayCreateConnection: () => true,
        connectionOwner: ownConnections,
        guardsPrivateHosts: true,
      };
    }
  }
}

export function switchMode(from: HostingMode, to: HostingMode, accounts: number): ModeSwitch {
  const changesHosting = from.kind !== to.kind;
  if (changesHosting && to.kind === "personal" && accounts > 1) {
    return { ok: false, reason: "accounts-exist" };
  }
  return {
    ok: true,
    deletePendingInvites: changesHosting,
    resetSignupMode: from.kind === "community" && to.kind !== "community",
  };
}
