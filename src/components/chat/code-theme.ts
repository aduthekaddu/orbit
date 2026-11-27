import type { PrismTheme } from "prism-react-renderer";

/** Prism colors from the --syntax-* tokens, shared by code blocks and the artifact Code tab. */
export const orbitCodeTheme: PrismTheme = {
  plain: { color: "var(--foreground)", backgroundColor: "transparent" },
  styles: [
    { types: ["comment", "prolog", "doctype", "cdata"], style: { color: "var(--syntax-comment)", fontStyle: "italic" } },
    { types: ["keyword", "boolean", "important", "atrule", "null"], style: { color: "var(--syntax-keyword)" } },
    {
      types: ["string", "char", "attr-value", "template-string", "triple-quoted-string"],
      style: { color: "var(--syntax-string)" },
    },
    { types: ["number", "constant", "symbol"], style: { color: "var(--syntax-number)" } },
    { types: ["function", "function-variable", "method"], style: { color: "var(--syntax-function)" } },
    { types: ["builtin", "class-name"], style: { color: "var(--syntax-class)" } },
    { types: ["property", "property-access"], style: { color: "var(--syntax-function)" } },
    { types: ["operator", "entity", "url"], style: { color: "var(--syntax-operator)" } },
    { types: ["tag"], style: { color: "var(--syntax-function)" } },
    { types: ["attr-name", "selector"], style: { color: "var(--syntax-class)" } },
    { types: ["punctuation"], style: { color: "var(--syntax-punctuation)" } },
    { types: ["decorator", "interpolation-punctuation", "format-spec"], style: { color: "var(--syntax-builtin)" } },
  ],
};
