import { tool } from "ai";
import { catalog, RENDER_UI_TOOL } from "./catalog";
import { parseRenderSpec } from "./spec";

export const renderUiTool = tool({
  description: "Render one UI spec. Arguments are one object with root and elements, not a patch stream.",
  inputSchema: catalog.zodSchema(),
  inputExamples: [
    {
      input: {
        root: "card",
        elements: {
          card: {
            type: "Card",
            props: { title: "Smoke", description: null },
            children: ["metric"],
          },
          metric: {
            type: "Metric",
            props: { label: "Checks", value: "1", hint: null },
            children: [],
          },
        },
      },
    },
  ],
  execute: async (input) => parseRenderSpec(input),
});

export const chatTools = {
  [RENDER_UI_TOOL]: renderUiTool,
};
