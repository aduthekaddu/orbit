"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useModelLists } from "@/components/use-model-lists";
import type { ModelDefaults, PickableConnection } from "@/lib/connections";
import { ConnectionSettings } from "./connections";
import { DefaultModelSettings } from "./default-model";
import { ModelListSettings } from "./model-list";

/** Connections, the default model, and each connection's models share one list of connections and their model lists. */
export function ModelSettings({ initialConnections, initialDefaults, canManageConnections }: {
  initialConnections: PickableConnection[];
  initialDefaults: ModelDefaults;
  canManageConnections: boolean;
}) {
  const router = useRouter();
  const [owned, setConnections] = useState(() => initialConnections.filter((connection) => "keyReadable" in connection));
  const connections = canManageConnections ? owned : initialConnections;
  const [defaults, setDefaults] = useState(initialDefaults);
  const { lists, load, setHidden } = useModelLists();
  const [firstIds] = useState(() => initialConnections.map((connection) => connection.id));

  useEffect(() => {
    for (const id of firstIds) load(id);
  }, [firstIds, load]);

  // Pages that read connections on the server stay in the router cache, so Back would show them stale.
  return (
    <>
      {canManageConnections ? <ConnectionSettings
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
      /> : null}
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
