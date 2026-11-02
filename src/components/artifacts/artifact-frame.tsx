"use client";

import { useEffect, useRef } from "react";
import { z } from "zod";

const frameMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("orbit-artifact-error"), message: z.string() }),
  z.object({ type: z.literal("orbit-artifact-close") }),
]);

export function ArtifactFrame({ document, onError, onClose }: {
  document: string;
  onError: (message: string) => void;
  onClose?: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    function receive(event: MessageEvent<unknown>) {
      if (event.source !== frame.current?.contentWindow) return;
      const result = frameMessage.safeParse(event.data);
      if (!result.success) return;
      if (result.data.type === "orbit-artifact-error") onError(result.data.message);
      else onClose?.();
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [onError, onClose]);
  return <iframe ref={frame} title="Artifact preview" sandbox="allow-scripts" srcDoc={document} className="h-full w-full border-0 bg-background" />;
}
