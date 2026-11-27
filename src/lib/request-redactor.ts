import { Redactor } from "./chat-errors";
import { listConnections, pickableConnectionOwner, redactionSecrets, toPublicConnection, type ConnectionSecrets } from "./connections";
import { getInstance, type InstanceSearchSecrets } from "./instance-settings";
import type { Viewer } from "./session";
import { getGithub } from "./user-github";

export function requestRedactor(viewer: Viewer, instance?: InstanceSearchSecrets, github = getGithub(viewer.id)): Redactor {
  const visibleInstance = viewer.role === "admin" ? (instance ?? getInstance()) : null;
  return new Redactor(visibleInstance, github, ...redactionSecrets(pickableConnectionOwner(viewer)));
}

/** Shared search credentials protect trusted output and logs, never submitted text or member-facing settings. */
export function modelRedactors(viewer: Viewer, provider: ConnectionSecrets, instance: InstanceSearchSecrets = getInstance(), github = getGithub(viewer.id)) {
  const input = requestRedactor(viewer, instance, github).withCredentials(provider);
  const output = viewer.role === "admin" ? input : input.withCredentials(instance);
  return { input, output };
}

export function publicConnections(viewer: Viewer) {
  const redact = requestRedactor(viewer);
  return listConnections(viewer.id).map((connection) => toPublicConnection(connection, redact));
}
