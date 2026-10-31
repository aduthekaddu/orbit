"use client";

import * as Collapsible from "@radix-ui/react-collapsible";
import type { ReasoningMessagePartComponent } from "@assistant-ui/react";
import { CaretRightIcon } from "@phosphor-icons/react";
import { MarkdownText } from "./markdown-text";

export const Reasoning: ReasoningMessagePartComponent = ({ status }) => {
  const running = status.type === "running";
  return (
    <Collapsible.Root className="group/reasoning my-3 first:mt-0">
      <Collapsible.Trigger className="flex items-center gap-1 rounded-sm text-xs text-muted-foreground transition-colors duration-150 ease-orbit outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
        {running ? "Thinking" : "Thought"}
        <CaretRightIcon
          weight="regular"
          className="size-3 transition-transform duration-200 ease-orbit group-data-[state=open]/reasoning:rotate-90"
        />
      </Collapsible.Trigger>
      <Collapsible.Content className="mt-2 border-l pl-3 text-muted-foreground">
        <MarkdownText className="text-xs leading-5" />
      </Collapsible.Content>
    </Collapsible.Root>
  );
};
