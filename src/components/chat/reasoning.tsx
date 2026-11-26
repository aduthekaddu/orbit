"use client";

import { useEffect, useState } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import type { ReasoningMessagePartComponent } from "@assistant-ui/react";
import { CaretRightIcon, LightbulbIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { readOrbitTiming, thinkingLabel, thoughtLabel } from "@/lib/thought-time";
import { MarkdownText } from "./markdown-text";
import { useReplyLink } from "./reply-link";
import { disclosureBody, disclosureTrigger } from "./disclosure";

export const Reasoning: ReasoningMessagePartComponent = ({ status, providerMetadata }) => {
  const { clockOffsetMs } = useReplyLink();
  const timing = readOrbitTiming(providerMetadata);
  const startedAt = timing?.startedAt;
  const thoughtMs = timing?.thoughtMs;
  const running = status.type === "running" && thoughtMs === undefined;
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!running || startedAt === undefined) return;
    const tick = () => setElapsedMs(Date.now() - clockOffsetMs - startedAt);
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [running, startedAt, clockOffsetMs]);

  const duration = thoughtMs !== undefined ? thoughtLabel(thoughtMs) : running && startedAt !== undefined ? thinkingLabel(elapsedMs) : null;
  return (
    <Collapsible.Root className="group/reasoning my-3 first:mt-0">
      <Collapsible.Trigger className={cn(disclosureTrigger, "w-fit group-data-[state=open]/reasoning:text-foreground")}>
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
      <Collapsible.Content className={cn(disclosureBody, "mt-3 text-muted-foreground")}>
        <MarkdownText className="text-sm leading-6" />
      </Collapsible.Content>
    </Collapsible.Root>
  );
};
