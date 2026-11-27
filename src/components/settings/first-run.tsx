"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useModelLists } from "@/components/use-model-lists";
import type { ModelDefaults, PublicConnection } from "@/lib/connections";
import type { ResolvedChoice } from "@/lib/model-choice";
import { ConnectionForm, ConnectionSettings } from "./connections";
import { DefaultModelSettings } from "./default-model";

type Unresolved = Extract<ResolvedChoice, { ok: false }>["reason"];

/** A chat that cannot send yet: add a connection, then choose the default model. Saving it opens the composer. */
export function FirstRun({ reason, initialConnections, defaults }: { reason: Unresolved; initialConnections: PublicConnection[]; defaults: ModelDefaults }) {
  const router = useRouter();
  const [connections, setConnections] = useState(initialConnections);
  const { lists, load } = useModelLists();
  const [firstIds] = useState(() => initialConnections.map((connection) => connection.id));

  useEffect(() => {
    for (const id of firstIds) load(id);
  }, [firstIds, load]);

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
  if (reason === "key-unreadable") {
    return (
      <ConnectionSettings
        connections={connections}
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
