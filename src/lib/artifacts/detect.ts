export type ArtifactKind = "html" | "svg" | "react";

export type Artifact = { key: string; kind: ArtifactKind; code: string };

export function artifactKind(_language: string): ArtifactKind | undefined {
  return undefined;
}
