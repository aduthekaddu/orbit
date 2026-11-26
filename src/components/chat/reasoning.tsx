"use client";

import { useEffect, useState } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import type { ReasoningMessagePartComponent } from "@assistant-ui/react";
import { CaretRightIcon, LightbulbIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { readOrbitTiming, thinkingLabel, thoughtLabel } from "@/lib/thought-time";
import { MarkdownText } from "./markdown-text";

export const Reasoning: ReasoningMessagePartComponent = ({ status, providerMetadata }) => {
  const timing = readOrbitTiming(providerMetadata);
  const startedAt = timing?.startedAt;
  const thoughtMs = timing?.thoughtMs;
  const running = status.type === "running" && thoughtMs === undefined;
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!running || startedAt === undefined) return;
    const tick = () => setElapsedMs(Date.now() - startedAt);
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [running, startedAt]);

  const duration = thoughtMs !== undefined ? thoughtLabel(thoughtMs) : running && startedAt !== undefined ? thinkingLabel(elapsedMs) : null;
  return (
    <Collapsible.Root className="group/reasoning my-3 first:mt-0">
      <Collapsible.Trigger className="flex h-7 items-center gap-1.5 rounded-full border bg-surface-sunken pr-2 pl-2.5 text-xs text-muted-foreground transition-colors duration-150 ease-orbit outline-none hover:border-border-strong hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 group-data-[state=open]/reasoning:text-foreground">
        <LightbulbIcon weight="regular" className={cn("size-3.5", running && "motion-safe:animate-pulse text-sun")} />
        <span>
          {running ? "Thinking" : duration ? "Thought for" : "Thought"}
          {duration && <> <span className="num">{duration}</span></>}
        </span>
        <CaretRightIcon
          weight="regular"
          className="size-3 transition-transform duration-200 ease-orbit group-data-[state=open]/reasoning:rotate-90"
        />
      </Collapsible.Trigger>
      <Collapsible.Content className="mt-3 ml-3.5 border-l pl-4 text-muted-foreground">
        <MarkdownText className="text-xs leading-5" />
      </Collapsible.Content>
    </Collapsible.Root>
  );
};
