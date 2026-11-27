"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useModelLists } from "@/components/use-model-lists";
import type { ModelDefaults, PublicConnection } from "@/lib/connections";
import { ConnectionSettings } from "./connections";
import { DefaultModelSettings } from "./default-model";
import { ModelListSettings } from "./model-list";

/** Connections, the default model, and each connection's models share one list of connections and their model lists. */
export function ModelSettings({ initialConnections, initialDefaults }: { initialConnections: PublicConnection[]; initialDefaults: ModelDefaults }) {
  const router = useRouter();
  const [connections, setConnections] = useState(initialConnections);
  const [defaults, setDefaults] = useState(initialDefaults);
  const { lists, load, setHidden } = useModelLists();
  const [firstIds] = useState(() => initialConnections.map((connection) => connection.id));

  useEffect(() => {
    for (const id of firstIds) load(id);
  }, [firstIds, load]);

  // Pages that read connections on the server stay in the router cache, so Back would show them stale.
  return (
    <>
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
      <DefaultModelSettings
        connections={connections}
        defaults={defaults}
        lists={lists}
        onRetry={load}
        onSaved={(saved) => {
          setDefaults(saved);
          router.refresh();
        }}
      />
      <ModelListSettings connections={connections} lists={lists} onRetry={load} onHidden={setHidden} />
    </>
  );
}
