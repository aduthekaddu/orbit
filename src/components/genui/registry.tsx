"use client";

import { defineRegistry, useStateStore, useStateValue } from "@json-render/react";
import { ArrowDownIcon, ArrowUpIcon, CheckCircleIcon, InfoIcon, PencilSimpleIcon, WarningIcon, type Icon } from "@phosphor-icons/react";
import { useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { catalog } from "@/lib/genui/catalog";
import { TABLE_ROW_CAP, changeDirection, changeToneOf, formatChange, formatValue, numericColumns, type Cell, type ChangeFormat, type ChangeTone } from "@/lib/genui/format";
import { cn } from "@/lib/utils";

const changeText: Record<ChangeTone, string> = {
  positive: "text-positive",
  negative: "text-negative",
  neutral: "text-muted-foreground",
};

type CalloutTone = "info" | "warning" | "success";

const calloutTones: Record<CalloutTone, { icon: Icon; className: string }> = {
  info: { icon: InfoIcon, className: "bg-info/10 before:bg-info [&>svg]:text-info" },
  warning: { icon: WarningIcon, className: "bg-warning/10 before:bg-warning [&>svg]:text-warning" },
  success: { icon: CheckCircleIcon, className: "bg-positive/10 before:bg-positive [&>svg]:text-positive" },
};

export const { registry } = defineRegistry(catalog, {
  components: {
    Card: ({ props, children }) => (
      <section data-genui-card className="min-w-0 in-data-genui-card:border-t in-data-genui-card:pt-4">
        <h3 className="text-h4 leading-snug font-semibold text-foreground">{props.title}</h3>
        {props.description ? <p className="mt-1 text-sm break-words text-muted-foreground">{props.description}</p> : null}
        {children ? (
          <div className="mt-4 flex min-w-0 flex-wrap gap-x-6 gap-y-5 *:min-w-0 *:basis-full [&>[data-metric]]:grow [&>[data-metric]]:basis-32">
            {children}
          </div>
        ) : null}
      </section>
    ),
    Metric: ({ props }) => <MetricView {...props} />,
    KeyValue: ({ props }) => (
      <dl data-keyvalue className="grid grid-cols-[fit-content(40%)_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
        {props.items.map((item, index) => (
          <div className="contents" key={`${item.label}-${index}`}>
            <dt className="break-words text-muted-foreground">{item.label}</dt>
            <dd className="min-w-0 break-words text-foreground tabular-nums">{formatValue(item.value)}</dd>
          </div>
        ))}
      </dl>
    ),
    Table: ({ props }) => <TableView columns={props.columns} rows={props.rows} />,
    List: ({ props }) => (
      <ul className="list-disc space-y-1 pl-5 text-prose break-words marker:text-muted-foreground">
        {props.items.map((item, index) => (
          <li key={`${item}-${index}`}>{formatValue(item)}</li>
        ))}
      </ul>
    ),
    Text: ({ props }) => <EditableText {...props} />,
    Callout: ({ props }) => <CalloutView {...props} />,
    Button: ({ props }) => <ButtonView {...props} />,
  },
});

function MetricView({
  label,
  value,
  hint,
  change,
  changeFormat,
  changeTone,
}: {
  label: string;
  value: Cell;
  hint?: string | null;
  change?: number | null;
  changeFormat?: ChangeFormat | null;
  changeTone?: ChangeTone | null;
}) {
  const moved = typeof change === "number";
  const tone = moved ? changeToneOf(change, changeTone) : "neutral";
  const direction = moved ? changeDirection(change) : "flat";
  const Arrow = direction === "up" ? ArrowUpIcon : direction === "down" ? ArrowDownIcon : null;
  return (
    <div data-metric>
      <p className="text-meta text-muted-foreground">{label}</p>
      <p data-metric-value className="mt-0.5 text-2xl font-semibold tracking-tight break-words text-foreground tabular-nums">{formatValue(value)}</p>
      {moved || hint ? (
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-meta">
          {moved ? (
            <span data-change data-tone={tone} className={cn("inline-flex items-center gap-0.5 font-medium tabular-nums", changeText[tone])}>
              {Arrow ? <Arrow data-arrow={direction} weight="bold" aria-hidden className="size-3" /> : null}
              {formatChange(change, changeFormat ?? "number")}
            </span>
          ) : null}
          {hint ? <span className="text-muted-foreground">{hint}</span> : null}
        </p>
      ) : null}
    </div>
  );
}

/** A text column whose longest cell passes this many characters wraps. Shorter columns stay on one line. */
const WRAP_AFTER = 32;

function TableView({ columns, rows }: { columns: string[]; rows: Cell[][] }) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const numeric = useMemo(() => numericColumns(rows), [rows]);
  const wrapping = useMemo(() => columns.map((_, index) => rows.some((row) => String(row[index] ?? "").length > WRAP_AFTER)), [columns, rows]);
  const capped = rows.length > TABLE_ROW_CAP;
  const shown = expanded || !capped ? rows : rows.slice(0, TABLE_ROW_CAP);
  return (
    <div data-genui-table>
      <ScrollFade axis="x" fade="var(--card)" scrollerLabel={columns.join(", ").slice(0, 120) || "Table"}>
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              {columns.map((column, index) => (
                <th
                  scope="col"
                  key={`${column}-${index}`}
                  className={cn(
                    "bg-[color-mix(in_oklab,var(--foreground)_6%,var(--card))] px-3 py-2 text-left text-meta font-medium whitespace-nowrap text-muted-foreground first:rounded-l-md last:rounded-r-md",
                    numeric[index] && "text-right",
                  )}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, rowIndex) => (
              <tr key={rowIndex} className="[&:not(:last-child)>td]:border-b [&>td]:border-border">
                {row.map((cell, cellIndex) => (
                  <td
                    key={cellIndex}
                    className={cn(
                      "px-3 py-2 align-top text-foreground",
                      numeric[cellIndex] ? "text-right whitespace-nowrap tabular-nums" : wrapping[cellIndex] ? "max-w-80 min-w-48 [overflow-wrap:anywhere]" : "whitespace-nowrap",
                    )}
                  >
                    {formatValue(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollFade>
      {capped ? (
        <Button
          ref={toggle}
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1 w-full text-muted-foreground hover:text-foreground pointer-coarse:h-11"
          onClick={() => {
            if (!expanded) return setExpanded(true);
            flushSync(() => setExpanded(false));
            toggle.current?.scrollIntoView({ block: "nearest" });
          }}
        >
          {expanded ? "Show fewer" : `Show all ${formatValue(rows.length)} rows`}
        </Button>
      ) : null}
    </div>
  );
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function EditableText({
  label,
  content,
  format,
}: {
  label?: string | null;
  content: string;
  format?: "plain" | "code" | null;
}) {
  const code = format === "code";
  const editable = (
    <div
      className={cn(
        "outline-none",
        code
          ? "w-max min-w-full p-3 pr-9 font-mono text-code whitespace-pre"
          : "rounded-md border border-dashed border-border-strong px-2.5 py-1.5 pr-9 text-prose whitespace-pre-wrap break-words transition-colors duration-150 ease-orbit hover:border-solid focus:border-solid focus:border-ring",
      )}
      contentEditable
      role="textbox"
      aria-label={label || (code ? "Generated code" : "Generated text")}
      aria-multiline
      spellCheck={!code}
      suppressContentEditableWarning
      onKeyDown={(event) => {
        if (event.key === "Escape") event.currentTarget.blur();
      }}
      dangerouslySetInnerHTML={{ __html: escapeHtml(content) }}
    />
  );
  return (
    <div className="flex flex-col gap-1.5">
      {label ? <p className="text-meta text-muted-foreground">{label}</p> : null}
      <div className="group/text relative">
        {code ? (
          <ScrollFade
            axis="x"
            fade="var(--surface-sunken)"
            className="rounded-md border border-dashed border-border-strong bg-surface-sunken transition-colors duration-150 ease-orbit hover:border-solid has-focus:border-solid has-focus:border-ring"
          >
            {editable}
          </ScrollFade>
        ) : (
          editable
        )}
        <PencilSimpleIcon
          aria-hidden
          weight="regular"
          className="pointer-events-none absolute top-2.5 right-2.5 z-20 size-3.5 text-muted-foreground transition-opacity duration-150 group-focus-within/text:opacity-0"
        />
      </div>
    </div>
  );
}

function CalloutView({
  tone,
  title,
  text,
  statePath,
}: {
  tone: CalloutTone;
  title?: string | null;
  text: string;
  statePath?: string | null;
}) {
  const watched = useStateValue<string>(statePath || "/note");
  const extra = statePath && typeof watched === "string" && watched.trim() ? watched : "";
  const { icon: ToneIcon, className } = calloutTones[tone];
  return (
    <div
      data-callout
      data-tone={tone}
      className={cn(
        "relative flex gap-2.5 overflow-hidden rounded-md py-2.5 pr-3 pl-3.5 text-sm text-foreground before:absolute before:inset-y-0 before:left-0 before:w-0.5",
        className,
      )}
    >
      <ToneIcon weight="regular" aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 break-words">
        {title ? <p className="font-medium">{title}</p> : null}
        <p className={title ? "mt-0.5" : undefined}>{text}</p>
        {extra ? <p className="mt-1.5 text-muted-foreground">{extra}</p> : null}
      </div>
    </div>
  );
}

function ButtonView({ label, note }: { label: string; action: "note"; note: string }) {
  const { set } = useStateStore();
  const [shown, setShown] = useState("");
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => {
          setShown(note);
          // Callouts may watch /note, so the click also updates the shared value.
          set("/note", note);
        }}
      >
        {label}
      </Button>
      {shown.trim() ? <p className="text-sm text-muted-foreground">{shown}</p> : null}
    </div>
  );
}
