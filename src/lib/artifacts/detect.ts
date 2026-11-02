export type ArtifactKind = "html" | "svg" | "react";

export type ArtifactLanguage = "html" | "svg" | "jsx" | "tsx";

export type Artifact = { key: string; kind: ArtifactKind; language: ArtifactLanguage; code: string };

const KIND_BY_LANGUAGE: Readonly<Record<ArtifactLanguage, ArtifactKind>> = {
  html: "html", svg: "svg", jsx: "react", tsx: "react",
};

export function isArtifactLanguage(language: string): language is ArtifactLanguage {
  return Object.hasOwn(KIND_BY_LANGUAGE, language);
}

export function artifactKind(language: string): ArtifactKind | undefined {
  return isArtifactLanguage(language) ? KIND_BY_LANGUAGE[language] : undefined;
}

export const ARTIFACT_INSTRUCTIONS = "For a page, chart, game, or interactive component, write one complete fenced code block tagged html, svg, or jsx. A jsx block imports only from react and default-exports one component.";
