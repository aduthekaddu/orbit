"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useModelLists } from "@/components/use-model-lists";
import type { ModelDefaults, PickableConnection } from "@/lib/connections";
import type { ResolvedChoice } from "@/lib/model-choice";
import { ConnectionForm, ConnectionSettings } from "./connections";
import { DefaultModelSettings } from "./default-model";

type Unresolved = Extract<ResolvedChoice, { ok: false }>["reason"];

export function FirstRun({ reason, initialConnections, defaults, canManageConnections }: {
  reason: Unresolved;
  initialConnections: PickableConnection[];
  defaults: ModelDefaults;
  canManageConnections: boolean;
}) {
  const router = useRouter();
  const [owned, setConnections] = useState(() => initialConnections.filter((connection) => "keyReadable" in connection));
  const connections = canManageConnections ? owned : initialConnections;
  const { lists, load } = useModelLists();
  const [firstIds] = useState(() => initialConnections.map((connection) => connection.id));

  useEffect(() => {
    for (const id of firstIds) load(id);
  }, [firstIds, load]);

  if (!canManageConnections && (connections.length === 0 || reason === "key-unreadable")) {
    return <p className="text-sm text-muted-foreground">Ask the admin to check the provider connection.</p>;
  }
  if (connections.length === 0) {
    return (
      <section aria-labelledby="first-connection-heading" className="rounded-xl border bg-card p-5 shadow-card">
        <h2 id="first-connection-heading" className="mb-4 text-sm font-medium">
          Add connection
        </h2>
        <ConnectionForm
          onSaved={(connection) => {
            setConnections([connection]);
            load(connection.id);
          }}
        />
      </section>
    );
  }
  if (canManageConnections && reason === "key-unreadable") {
    return (
      <ConnectionSettings
        connections={owned}
        onAdded={(connection) => {
          setConnections((current) => [...current, connection]);
          load(connection.id);
          router.refresh();
        }}
        onUpdated={(connection) => {
          setConnections((current) => current.map((item) => (item.id === connection.id ? connection : item)));
          load(connection.id);
          router.refresh();
        }}
        onDeleted={(id) => {
          setConnections((current) => current.filter((item) => item.id !== id));
          router.refresh();
        }}
      />
    );
  }
  return <DefaultModelSettings connections={connections} defaults={defaults} lists={lists} onRetry={load} onSaved={() => router.refresh()} />;
}
