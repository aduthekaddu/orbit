import type { ArtifactKind, ArtifactLanguage } from "./detect";

export type ArtifactVersionSummary = {
  id: string;
  /** 1-based rank in the lineage by (createdAt ASC, seq ASC). */
  number: number;
  messageId: string;
  key: string;
  language: ArtifactLanguage;
  derivedTitle: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredChatArtifact = {
  id: string;
  key: string;
  title: string;
  derivedTitle: string;
  userTitle: string | null;
  lineageId: string;
  number: number;
  versions: ArtifactVersionSummary[];
};

export type ArtifactListItem = {
  /** The lineage's newest version. */
  id: string;
  lineageId: string;
  kind: ArtifactKind;
  language: ArtifactLanguage;
  title: string;
  derivedTitle: string;
  userTitle: string | null;
  chatId: string;
  chatTitle: string;
  messageId: string;
  key: string;
  versionCount: number;
  createdAt: string;
  /** The newest updatedAt across the lineage. */
  updatedAt: string;
};

export type ArtifactDetail = {
  id: string;
  chatId: string;
  chatTitle: string;
  messageId: string;
  textOrdinal: number;
  blockIndex: number;
  key: string;
  kind: ArtifactKind;
  language: ArtifactLanguage;
  code: string;
  title: string;
  derivedTitle: string;
  userTitle: string | null;
  lineageId: string;
  number: number;
  createdAt: string;
  updatedAt: string;
  versions: ArtifactVersionSummary[];
};

export type ArtifactPage = { items: ArtifactListItem[]; nextCursor: string | null };
