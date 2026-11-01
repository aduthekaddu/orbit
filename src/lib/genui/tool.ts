import { tool } from "ai";
import { catalog, RENDER_UI_TOOL, RENDER_UI_TOOL_DESCRIPTION } from "./catalog";
import { parseRenderSpec } from "./spec";

export const renderUiTool = tool({
  description: RENDER_UI_TOOL_DESCRIPTION,
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
