import { Redactor } from "./chat-errors";
import { listConnections, pickableConnectionOwner, redactionSecrets, toPublicConnection, type ConnectionSecrets, type PickableConnection } from "./connections";
import { getInstance, type InstanceSearchSecrets } from "./instance-settings";
import type { Viewer } from "./session";
import { getGithub, type UserGithubSecrets } from "./user-github";

export function requestRedactor(viewer: Viewer, instance?: InstanceSearchSecrets, github: UserGithubSecrets = getGithub(viewer.id)): Redactor {
  const visibleInstance = viewer.role === "admin" ? (instance ?? getInstance()) : null;
  return new Redactor(visibleInstance, github, ...redactionSecrets(viewer.id));
}

export function modelRedactors(viewer: Viewer, provider: ConnectionSecrets, {
  ownProvider, instance = getInstance(), github = getGithub(viewer.id),
}: { ownProvider: boolean; instance?: InstanceSearchSecrets; github?: UserGithubSecrets }) {
  const request = requestRedactor(viewer, instance, github);
  return {
    input: ownProvider ? request.withCredentials(provider) : request,
    output: request.withCredentials(provider, instance),
  };
}

export function publicConnections(viewer: Viewer): PickableConnection[] {
  const ownerId = pickableConnectionOwner(viewer);
  const connections = listConnections(ownerId);
  if (ownerId === viewer.id) {
    const redact = requestRedactor(viewer);
    return connections.map((connection) => toPublicConnection(connection, redact));
  }
  const redact = requestRedactor({ id: ownerId, role: "admin" });
  return connections.map(({ id, kind, label }) => ({ id, kind, label: redact.text(label) }));
}
