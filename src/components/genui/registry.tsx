"use client";

import { defineRegistry, useStateStore, useStateValue } from "@json-render/react";
import { useState } from "react";
import { catalog } from "@/lib/genui/catalog";

const toneClass = {
  info: "border-border bg-muted",
  warning: "border-destructive/40 bg-destructive/10",
  success: "border-primary/20 bg-secondary",
} as const;

export const { registry } = defineRegistry(catalog, {
  components: {
    Card: ({ props, children }) => (
      <section className="rounded-xl border bg-card p-4 text-card-foreground">
        <h3 className="text-sm font-medium">{props.title}</h3>
        {props.description ? <p className="mt-1 text-sm text-muted-foreground">{props.description}</p> : null}
        {children ? <div className="mt-3 flex flex-col gap-3">{children}</div> : null}
      </section>
    ),
    Metric: ({ props }) => (
      <div className="rounded-xl border bg-card p-4">
        <p className="text-sm text-muted-foreground">{props.label}</p>
        <p className="mt-1 text-2xl font-medium">{props.value}</p>
        {props.hint ? <p className="mt-1 text-meta text-muted-foreground">{props.hint}</p> : null}
      </div>
    ),
    KeyValue: ({ props }) => (
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        {props.items.map((item, index) => (
          <div className="contents" key={`${item.label}-${index}`}>
            <dt className="text-muted-foreground">{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
    ),
    Table: ({ props }) => (
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr>
              {props.columns.map((column, index) => (
                <th className="border-b px-3 py-2 font-medium" key={`${column}-${index}`}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td className="border-b px-3 py-2" key={cellIndex}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ),
    List: ({ props }) => (
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {props.items.map((item, index) => (
          <li key={`${item}-${index}`}>{item}</li>
        ))}
      </ul>
    ),
    Text: ({ props }) => <EditableText {...props} />,
    Callout: ({ props }) => <CalloutView {...props} />,
    Button: ({ props }) => <ButtonView {...props} />,
  },
});

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
  return (
    <div className="flex flex-col gap-1 text-sm">
      {label ? <p className="text-meta text-muted-foreground">{label}</p> : null}
      <div
        className={
          code
            ? "overflow-x-auto whitespace-pre-wrap break-words rounded-xl border bg-muted/40 p-3 font-mono text-code"
            : "whitespace-pre-wrap break-words rounded-xl border border-transparent px-1 py-0.5 hover:border-border focus:border-border focus:outline-none"
        }
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
    </div>
  );
}

function CalloutView({
  tone,
  title,
  text,
  statePath,
}: {
  tone: "info" | "warning" | "success";
  title?: string | null;
  text: string;
  statePath?: string | null;
}) {
  const watched = useStateValue<string>(statePath || "/note");
  const extra = statePath && typeof watched === "string" && watched.trim() ? watched : "";
  return (
    <div className={`rounded-xl border p-3 text-sm ${toneClass[tone]}`}>
      {title ? <p className="font-medium">{title}</p> : null}
      <p className={title ? "mt-1" : undefined}>{text}</p>
      {extra ? <p className="mt-2 text-muted-foreground">{extra}</p> : null}
    </div>
  );
}

function ButtonView({ label, note }: { label: string; action: "note"; note: string }) {
  const { set } = useStateStore();
  const [shown, setShown] = useState("");
  return (
    <div className="flex flex-col items-start gap-2">
      <button
        className="inline-flex rounded-full bg-primary px-3 py-1.5 text-sm text-primary-foreground"
        type="button"
        onClick={() => {
          setShown(note);
          // Callouts may watch /note, so the click also updates the shared value.
          set("/note", note);
        }}
      >
        {label}
      </button>
      {shown.trim() ? <p className="text-sm text-muted-foreground">{shown}</p> : null}
    </div>
  );
}
