"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type Axis = "x" | "y";
type Edges = { start: boolean; end: boolean };

const NONE: Edges = { start: false, end: false };

function readEdges(el: HTMLElement, axis: Axis): Edges {
  const offset = axis === "x" ? el.scrollLeft : el.scrollTop;
  const hidden = axis === "x" ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
  return { start: offset > 1, end: hidden - offset > 1 };
}

/**
 * A scroller that fades whichever edge has more content behind it, so a cut line or row reads as
 * "keep scrolling" instead of clipping. `fade` is the color the content fades into: the surface behind it.
 */
export function ScrollFade({
  axis,
  fade,
  className,
  scrollerClassName,
  scrollerLabel,
  style,
  children,
  ...props
}: {
  axis: Axis;
  fade: string;
  scrollerClassName?: string;
  scrollerLabel?: string;
} & React.ComponentProps<"div">) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edges>(NONE);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () =>
      setEdges((prev) => {
        const next = readEdges(el, axis);
        return prev.start === next.start && prev.end === next.end ? prev : next;
      });
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [axis]);

  // An edge fade is a square box in a corner of its container. Taking the container's radius keeps a rounded well's corners round while the fade shows.
  const edge = "pointer-events-none absolute z-10 rounded-[inherit] transition-opacity duration-200 ease-orbit";
  const side =
    axis === "x"
      ? ["inset-y-0 left-0 w-10 bg-gradient-to-r", "inset-y-0 right-0 w-10 bg-gradient-to-l"]
      : ["inset-x-0 top-0 h-8 bg-gradient-to-b", "inset-x-0 bottom-0 h-8 bg-gradient-to-t"];

  return (
    <div className={cn("relative min-h-0", className)} style={{ ...style, "--fade": fade } as React.CSSProperties} {...props}>
      <div aria-hidden className={cn(edge, side[0], "from-(color:--fade)", edges.start ? "opacity-100" : "opacity-0")} />
      <div
        ref={scroller}
        role={scrollerLabel ? "region" : undefined}
        aria-label={scrollerLabel}
        tabIndex={scrollerLabel ? 0 : undefined}
        className={cn(axis === "x" ? "overflow-x-auto" : "overflow-y-auto", "scrollbar-thin", scrollerLabel && "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", scrollerClassName)}
      >
        {children}
      </div>
      <div aria-hidden className={cn(edge, side[1], "from-(color:--fade)", edges.end ? "opacity-100" : "opacity-0")} />
    </div>
  );
}
