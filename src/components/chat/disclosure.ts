/** The pill that opens a disclosure in a reply: reasoning, and every tool line. One class so they read as one family. */
export const disclosureTrigger =
  "flex h-7 max-w-full min-w-0 cursor-pointer list-none items-center gap-1.5 rounded-full border bg-surface-sunken pr-2 pl-2.5 text-meta text-muted-foreground transition-colors duration-150 ease-orbit outline-none select-none hover:border-border-strong hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:h-11 pointer-coarse:pr-3 pointer-coarse:pl-3.5 [&::-webkit-details-marker]:hidden";

/** The body under an open disclosure, hung from a hairline like a quote. */
export const disclosureBody = "mt-2 ml-3.5 min-w-0 border-l pl-4";
