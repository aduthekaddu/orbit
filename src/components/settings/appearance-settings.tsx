"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  appearanceSchema,
  applyAppearance,
  nextPatch,
  reduceSaveQueue,
  saveQueue,
  shownAppearance,
  type Appearance,
  type SaveQueue,
  type SaveQueueEvent,
} from "@/lib/appearance";
import { requestJson } from "@/lib/request-json";
import { cn } from "@/lib/utils";
import { Row } from "./row";

type Option<K extends keyof Appearance> = { value: Appearance[K]; label: string; content?: React.ReactNode };

const THEME_OPTIONS: Option<"theme">[] = [
  { value: "dark", label: "Dark" },
  { value: "dim", label: "Dim" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
];

const TEXT_SIZE_OPTIONS: Option<"textSize">[] = [
  { value: "sm", label: "Small", content: <span className="text-[15px]">Aa</span> },
  { value: "md", label: "Medium", content: <span className="text-[16px]">Aa</span> },
  { value: "lg", label: "Large", content: <span className="text-[18px]">Aa</span> },
  { value: "xl", label: "Extra large", content: <span className="text-[20px]">Aa</span> },
];

const REPLY_FONT_OPTIONS: Option<"replyFont">[] = [
  { value: "sans", label: "Sans", content: <span className="font-sans">Sans</span> },
  { value: "serif", label: "Serif", content: <span className="font-serif text-[1.0625em]">Serif</span> },
];

const CHAT_WIDTH_OPTIONS: Option<"chatWidth">[] = [
  { value: "normal", label: "Normal" },
  { value: "wide", label: "Wide" },
];

const swatch = (color: string) => <span aria-hidden className={cn("size-4 rounded-full shadow-[inset_0_0_0_1px_var(--border)]", color)} />;

const ACCENT_OPTIONS: Option<"accent">[] = [
  { value: "sun", label: "Sun", content: swatch("bg-(--accent-preset-sun)") },
  { value: "sky", label: "Sky", content: swatch("bg-(--accent-preset-sky)") },
  { value: "rose", label: "Rose", content: swatch("bg-(--accent-preset-rose)") },
  { value: "sand", label: "Sand", content: swatch("bg-(--accent-preset-sand)") },
];

export function AppearanceSettings({ initial }: { initial: Appearance }) {
  const router = useRouter();
  const [queue, setQueue] = useState(() => saveQueue(initial));
  const current = useRef<SaveQueue>(queue);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function dispatch(event: SaveQueueEvent) {
    current.current = reduceSaveQueue(current.current, event);
    if (mounted.current) {
      setQueue(current.current);
      applyAppearance(shownAppearance(current.current));
    }
    return current.current;
  }

  function flush() {
    const patch = nextPatch(current.current);
    if (!patch) return;
    dispatch({ type: "send" });
    void requestJson(
      "/api/preferences",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) },
      {
        parse: appearanceSchema,
        onOk: (appearance) => {
          if (nextPatch(dispatch({ type: "saved", appearance }))) flush();
          else router.refresh();
        },
        onFailed: (failure) => {
          dispatch({ type: "failed", error: (failure.kind === "http" && failure.error) || "Could not save" });
          router.refresh();
        },
      },
    );
  }

  function select<K extends keyof Appearance>(key: K, value: string) {
    // Radix's single ToggleGroup sends "" when the chosen item is clicked again.
    if (!value) return;
    dispatch({ type: "select", patch: { [key]: value } as Partial<Appearance> });
    flush();
  }

  const shown = shownAppearance(queue);

  return (
    <section aria-labelledby="appearance-heading" className="rounded-xl border bg-card shadow-card">
      <div className="border-b px-5 py-3.5">
        <h2 id="appearance-heading" className="text-sm font-medium">
          Appearance
        </h2>
      </div>
      <div className="divide-y">
        <Choice id="theme" label="Theme" value={shown.theme} options={THEME_OPTIONS} onChange={(value) => select("theme", value)} />
        <Choice id="textSize" label="Text size" value={shown.textSize} options={TEXT_SIZE_OPTIONS} onChange={(value) => select("textSize", value)} />
        <Choice id="replyFont" label="Reply font" value={shown.replyFont} options={REPLY_FONT_OPTIONS} onChange={(value) => select("replyFont", value)} />
        <Choice
          id="chatWidth"
          label="Chat width"
          value={shown.chatWidth}
          options={CHAT_WIDTH_OPTIONS}
          onChange={(value) => select("chatWidth", value)}
          className="hidden md:grid"
        />
        <Choice id="accent" label="Accent" value={shown.accent} options={ACCENT_OPTIONS} onChange={(value) => select("accent", value)} />
      </div>
      {queue.error ? (
        <p role="alert" className="flex items-center gap-2 border-t px-5 py-3 text-meta text-destructive">
          <WarningCircleIcon weight="regular" className="size-3.5 shrink-0" />
          {queue.error}
        </p>
      ) : null}
    </section>
  );
}

function Choice<K extends keyof Appearance>({
  id,
  label,
  value,
  options,
  onChange,
  className,
}: {
  id: string;
  label: string;
  value: Appearance[K];
  options: Option<K>[];
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <Row id={id} label={label} labelledControl={false} className={className}>
      <ToggleGroup
        type="single"
        variant="pill"
        size="sm"
        value={value}
        onValueChange={onChange}
        aria-labelledby={`${id}-label`}
        className="w-full rounded-full border bg-surface-sunken p-0.5 sm:w-fit"
      >
        {options.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            aria-label={option.label}
            className="flex-1 px-3 sm:flex-initial pointer-coarse:h-11 pointer-coarse:min-w-11"
          >
            {option.content ?? option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </Row>
  );
}
