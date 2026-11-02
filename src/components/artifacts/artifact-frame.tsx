export function ArtifactFrame({ document }: { document: string; onError: (message: string) => void }) {
  return <iframe title="Artifact preview" srcDoc={document} />;
}
