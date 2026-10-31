import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

const text = () => z.string();
const shown = () => z.union([z.string(), z.number()]).transform((value) => String(value));

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
      }),
      description: "One labeled number or short value. A numeric value is stored as text.",
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

export const RENDER_UI_SYSTEM = [
  "Answer in plain text.",
  "When the user wants a card, table, list, metric, key-value pairs, or a callout, call render_ui once.",
  "The tool arguments are one spec object with root and elements, not a JSON patch stream.",
  "Each element has type, props, and children. children is an array of element keys, or an empty array.",
  "Use only Card, Metric, KeyValue, Table, List, Callout, and Button.",
  "Button action is the string note, and note is the text the click stores.",
  "Metric, list, table, and key-value values may be strings or numbers.",
  "Pass null for an optional string you are not using.",
].join(" ");
