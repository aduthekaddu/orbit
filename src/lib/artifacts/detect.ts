export type ArtifactKind = "html" | "svg" | "react";

export type Artifact = { key: string; kind: ArtifactKind; code: string };

const KIND_BY_LANGUAGE: Readonly<Record<string, ArtifactKind | undefined>> = {
  html: "html", svg: "svg", jsx: "react", tsx: "react",
};

export function artifactKind(language: string): ArtifactKind | undefined {
  return Object.hasOwn(KIND_BY_LANGUAGE, language) ? KIND_BY_LANGUAGE[language] : undefined;
}

export const ARTIFACT_INSTRUCTIONS = "For a page, chart, game, or interactive component, write one complete fenced code block tagged html, svg, or jsx. A jsx block imports only from react and default-exports one component.";
