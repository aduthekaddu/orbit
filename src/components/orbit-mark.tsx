import { cn } from "@/lib/utils";

const RING_TILT = "rotate(-28 12 12)";

export function OrbitMark({ className, busy = false }: { className?: string; busy?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-6 shrink-0", className)} aria-hidden>
      <g transform={RING_TILT}>
        <ellipse cx="12" cy="12" rx="10" ry="4" className="fill-none stroke-primary/45" strokeWidth={1.5} />
      </g>
      <circle cx="12" cy="12" r="4.4" className="fill-foreground" />
      <g transform={RING_TILT}>
        <path d="M22 12 A10 4 0 0 1 2 12" className="fill-none stroke-primary" strokeWidth={1.6} strokeLinecap="round" />
        <g className={cn(busy && "motion-safe:animate-orbit-x")}>
          <g className={cn(busy && "motion-safe:animate-orbit-y")}>
            <circle cx="22" cy="12" r="1.8" className="fill-primary" />
          </g>
        </g>
      </g>
    </svg>
  );
}
