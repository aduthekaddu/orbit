import { useId } from "react";
import { cn } from "@/lib/utils";

const RING_TILT = "rotate(-28 12 12)";

const tones = {
  accent: { ring: "stroke-primary/45", arc: "stroke-primary", moon: "fill-primary" },
  mono: { ring: "stroke-muted-foreground/40", arc: "stroke-muted-foreground", moon: "fill-muted-foreground" },
} as const;

export type OrbitMarkTone = keyof typeof tones;

/**
 * The moon is drawn twice, clipped to the far and near halves of the ring. The far copy sits under
 * the planet and the near copy over it, so a busy moon passes behind the planet and back in front.
 */
export function OrbitMark({
  className,
  busy = false,
  tone = "accent",
}: {
  className?: string;
  busy?: boolean;
  tone?: OrbitMarkTone;
}) {
  const id = useId();
  const colors = tones[tone];
  const moon = (
    <g className={cn(busy && "motion-safe:animate-orbit-x")}>
      <g className={cn(busy && "motion-safe:animate-orbit-y")}>
        <circle
          cx="22"
          cy="12"
          r="1.8"
          className={cn(colors.moon, "origin-center [transform-box:fill-box]", busy && "motion-safe:animate-orbit-z")}
        />
      </g>
    </g>
  );
  return (
    <svg viewBox="0 0 24 24" className={cn("size-6 shrink-0", className)} aria-hidden>
      <defs>
        <clipPath id={`${id}-far`}>
          <rect x="-2" y="4" width="28" height="8" />
        </clipPath>
        <clipPath id={`${id}-near`}>
          <rect x="-2" y="12" width="28" height="8" />
        </clipPath>
      </defs>
      <g transform={RING_TILT}>
        <ellipse cx="12" cy="12" rx="10" ry="4" className={cn("fill-none", colors.ring)} strokeWidth={1.5} />
        <g clipPath={`url(#${id}-far)`}>{moon}</g>
      </g>
      <circle cx="12" cy="12" r="4.4" className="fill-foreground" />
      <g transform={RING_TILT}>
        <path d="M22 12 A10 4 0 0 1 2 12" className={cn("fill-none", colors.arc)} strokeWidth={1.6} strokeLinecap="round" />
        <g clipPath={`url(#${id}-near)`}>{moon}</g>
      </g>
    </svg>
  );
}
