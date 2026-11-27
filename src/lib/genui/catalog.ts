import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

const text = () => z.string();
const shown = () => z.union([z.string(), z.number()]);

export const RENDER_UI_TOOL = "render_ui";

export const catalog = defineCatalog(schema, {
  components: {
    Card: {
      props: z.object({
        title: text(),
        description: text().nullable().optional(),
      }),
      description: "A card with a title, an optional description, and child components.",
      slots: ["default"],
    },
    Metric: {
      props: z.object({
        label: text(),
        value: shown(),
        hint: text().nullable().optional(),
        change: z.number().nullable().optional(),
        changeFormat: z.enum(["percent", "number"]).nullable().optional(),
        changeTone: z.enum(["positive", "negative", "neutral"]).nullable().optional(),
      }),
      description: "One labeled number or short value. change is how much it moved, in changeFormat units (default number). changeTone defaults to positive for a rise and negative for a drop.",
    },
    KeyValue: {
      props: z.object({
        items: z.array(z.object({ label: text(), value: shown() })),
      }),
      description: "Pairs of labels and values. No chart.",
    },
    Table: {
      props: z.object({
        columns: z.array(text()),
        rows: z.array(z.array(shown())),
      }),
      description: "A table. Each row is an array of strings or numbers in column order.",
    },
    List: {
      props: z.object({
        items: z.array(shown()),
      }),
      description: "A bullet list of strings.",
    },
    Text: {
      props: z.object({
        content: text(),
        format: z.enum(["plain", "code"]).nullable().optional(),
        label: text().nullable().optional(),
      }),
      description: "Text or code. content is shown in place and can be edited by the user.",
    },
    Callout: {
      props: z.object({
        tone: z.enum(["info", "warning", "success"]),
        title: text().nullable().optional(),
        text: text(),
        statePath: text().nullable().optional(),
      }),
      description: "A short notice. statePath reads a state value when it is set, for example /note.",
    },
    Button: {
      props: z.object({
        label: text(),
        action: z.literal("note"),
        note: text(),
      }),
      description: "A button. action is note. A click stores note and shows it under the button.",
    },
  },
  actions: {},
});

type JsonSchema = {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
};

function literal(value: unknown) {
  return JSON.stringify(value);
}

function typeName(schema: JsonSchema): string {
  if (schema.const !== undefined) return literal(schema.const);
  if (schema.enum) return schema.enum.map(literal).join(" | ");
  if (schema.anyOf) return schema.anyOf.map(typeName).join(" or ");
  if (Array.isArray(schema.type)) return schema.type.join(" or ");
  if (schema.type === "array") return `array of ${schema.items ? typeName(schema.items) : "values"}`;
  if (schema.type === "object" && schema.properties) {
    const required = new Set(schema.required ?? []);
    const fields = Object.entries(schema.properties).map(
      ([name, prop]) => `${name} (${typeName(prop)}, ${required.has(name) ? "required" : "optional"})`,
    );
    return `{ ${fields.join("; ")} }`;
  }
  return schema.type ?? "value";
}

function componentProps(schema: z.ZodType): string {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties ?? {})
    .map(([name, prop]) => `${name} (${typeName(prop)}, ${required.has(name) ? "required" : "optional"})`)
    .join("; ");
}

export function componentPropDocs() {
  return Object.entries(catalog.data.components)
    .map(([name, component]) => `${name}: ${componentProps(component.props as z.ZodType)}.`)
    .join(" ");
}

export const RENDER_UI_SYSTEM = [
  "Answer in plain text.",
  "When the user wants a card, table, list, metric, key-value pairs, or a callout, call render_ui once.",
  "The tool arguments are one spec object with root and elements, not a JSON patch stream.",
  "Each element has type, props, and children. children is an array of element keys, or an empty array.",
  "Use only Card, Metric, KeyValue, Table, List, Text, Callout, and Button.",
  "Text holds plain text or code. format is plain or code.",
  "Button action is the string note, and note is the text the click stores.",
  "Metric, list, table, and key-value values may be strings or numbers. Pass numbers as numbers, not text, so they are formatted.",
  "Give Metric a change number when the value moved, and set changeTone when a drop is good.",
  "Pass null for an optional string you are not using.",
  `Component props. ${componentPropDocs()}`,
].join(" ");

export const RENDER_UI_TOOL_DESCRIPTION = [
  "Render one UI spec. Arguments are one object with root and elements, not a patch stream.",
  `Component props. ${componentPropDocs()}`,
].join(" ");
