import { Redactor } from "./chat-errors";
import { listConnections, pickableConnectionOwner, redactionSecrets, toPublicConnection } from "./connections";
import { getInstance } from "./instance-settings";
import type { Viewer } from "./session";
import { getGithub } from "./user-github";

export function requestRedactor(viewer: Viewer, instance = getInstance(), github = getGithub(viewer.id)): Redactor {
  return new Redactor(instance, github, ...redactionSecrets(pickableConnectionOwner(viewer)));
}

export function publicConnections(viewer: Viewer) {
  const redact = requestRedactor(viewer);
  return listConnections(viewer.id).map((connection) => toPublicConnection(connection, redact));
}
