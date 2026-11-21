import type { Root, RootContent } from "hast";

/**
 * Tag each fenced code block with its source offsets. The markdown memo compares
 * node properties, not positions, so the fence offset must be a property for a
 * moved block to re-render.
 */
export function rehypeCodeBlocks() {
  return (tree: Root) => {
    let index = 0;
    function visit(node: Root | RootContent) {
      if (node.type === "element" && node.tagName === "pre") {
        const code = node.children.find((child) => child.type === "element" && child.tagName === "code");
        if (code?.type === "element") {
          code.properties["data-code-index"] = index++;
          if (code.position?.start.offset !== undefined) code.properties["data-code-fence"] = code.position.start.offset;
        }
      }
      if ("children" in node) node.children.forEach(visit);
    }
    visit(tree);
  };
}
