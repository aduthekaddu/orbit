"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { OrbitMark } from "@/components/orbit-mark";
import { currentTurnIndex, visibleTurns } from "@/lib/thread-map";
import { Bar, Popover, Stage, Window, useReducedMotion, type Act } from "@/vendor/stageshow";
import "./auth-demo.css";

// The thread map, as the chat shows it. The cursor reaches the rail of ticks on the thread's right
// edge, the rail opens into the list of prompts, an earlier prompt is picked, and the thread scrolls
// to it while its tick turns sun. A trackpad scroll back to the end is the reset.

type Answer = { prose: string } | { lines: (number | string)[] };
type Turn = { prompt: string; bar?: number; answer: Answer };

const TARGET = 1;

// Words show only where the story touches: the prompt picked, its answer, and the popover's list.
const TURNS: Turn[] = [
  { prompt: "Compare flights from Berlin", bar: 168, answer: { lines: ["94%", "88%", "71%", 18, "90%", "56%"] } },
  {
    prompt: "Plan the Lisbon trip budget",
    answer: {
      prose:
        "For five days, budget about €1,150 each. Flights from Berlin run €180 return, an apartment in Alfama is €520 for the week, and food comes to €60 a day. Keep €150 for trams, the Sintra train and a fado night.",
    },
  },
  { prompt: "Where to stay in Alfama", bar: 132, answer: { lines: ["92%", "84%", "40%", 18, "88%", "64%"] } },
  { prompt: "Day trip to Sintra", bar: 112, answer: { lines: ["90%", "76%", 18, "86%", "93%", "48%"] } },
  { prompt: "Best pastéis de nata", bar: 148, answer: { lines: ["88%", "62%", 18, "92%", "70%"] } },
  { prompt: "Tram 28 or walk?", bar: 96, answer: { lines: ["94%", "80%", "52%", 18, "86%", "44%"] } },
  { prompt: "What to pack for October", bar: 160, answer: { lines: ["91%", "86%", "66%", 18, "90%", "58%"] } },
  { prompt: "Rewrite the itinerary as a table", bar: 184, answer: { lines: ["84%", "92%", "88%", "90%", "72%"] } },
];

type Pos = number | "end";
type S = { open: boolean; at: Pos; view: Pos };

const initial: S = { open: false, at: "end", view: "end" };
const poster: S = { open: false, at: TARGET, view: TARGET };

// The real thread scrolls a jumped-to prompt to 24px under the top (scroll-mt-6).
const SCROLL_MARGIN = 24;
const REST = { x: 704, y: 700 };

async function script(a: Act<S>) {
  await a.wait(600);
  a.mark("hover");
  await a.move({ at: "rail", x: 0.7, y: 0.5 });
  await a.set({ open: true });
  await a.wait(1200);
  // Into the list level with the rail, then up to the earlier prompt
  await a.move({ at: "row-4", x: 0.86, y: 0.55 });
  await a.wait(350);
  await a.move({ at: `row-${TARGET}`, x: 0.86, y: 0.55 });
  await a.wait(300);
  a.mark("jump");
  await a.click();
  await a.set({ open: false, at: TARGET });
  // The ticks follow the scroll, a beat behind the click
  await a.wait(420);
  await a.set({ view: TARGET });
  await a.move({ x: 704, y: 330 });
  a.mark("payoff");
  await a.wait(3000);
  // Reset: a trackpad scroll back to the newest turn, the pointer resting on the thread
  a.mark("reset");
  await a.set({ at: "end" });
  await a.wait(420);
  await a.set({ view: "end" });
  await a.wait(600);
  await a.move(REST);
  await a.wait(300);
}

// Tailwind's lg breakpoint; below it the sign-in page is one column and the demo stays unmounted.
const WIDE = "(min-width: 64rem)";

export function AuthDemo() {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  if (!wide) return null;
  return (
    <div className="auth-demo" aria-hidden>
      <Stage<S>
        width={760}
        height={900}
        fill
        theme="dark"
        initial={initial}
        poster={poster}
        script={script}
        cursor={{ at: REST }}
        tokens={{ "--ss-font": "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif" }}
      >
        {(s) => (
          <Window className="ad-win" title="Lisbon trip" sidebar={<Sidebar />} sidebarWidth={168} lights="grey">
            <ThreadPane at={s.at} view={s.view} open={s.open} />
          </Window>
        )}
      </Stage>
    </div>
  );
}

function Sidebar() {
  return (
    <div className="ad-side">
      <div className="ad-brand">
        <OrbitMark className="size-4" />
        <span>orbit</span>
      </div>
      <div className="ad-search">
        <MagnifyingGlassIcon weight="regular" className="size-3.5" />
        <span>Search</span>
      </div>
      <div className="ad-chats">
        <div className="ad-chat" data-active>
          Lisbon trip
        </div>
        {[92, 70, 104, 64, 86].map((w, i) => (
          <div key={i} className="ad-chat">
            <Bar w={w} h={6} r={3} tone={3} />
          </div>
        ))}
        <div className="ad-group">
          <Bar w={44} h={5} r={2.5} tone={2} />
        </div>
        {[78, 98, 58, 88, 72, 94, 66, 84, 60, 96, 74, 90, 68, 82].map((w, i) => (
          <div key={i} className="ad-chat">
            <Bar w={w} h={6} r={3} tone={3} />
          </div>
        ))}
      </div>
    </div>
  );
}

type Geometry = { tops: number[]; height: number; view: number };

function ThreadPane({ at, view, open }: { at: Pos; view: Pos; open: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState<Geometry | null>(null);
  const reduced = useReducedMotion();
  // The first measured position lands without a transition; only later moves glide.
  const placed = useRef(false);
  useEffect(() => {
    if (geo) placed.current = true;
  }, [geo]);

  // offsetTop and clientHeight ignore the stage's scale, so these are design pixels.
  useLayoutEffect(() => {
    const root = viewport.current;
    const content = track.current;
    if (!root || !content) return;
    const measure = () => {
      const tops = Array.from(content.querySelectorAll<HTMLElement>("[data-turn]")).map((el) => el.offsetTop);
      setGeo({ tops, height: content.offsetHeight, view: root.clientHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(content);
    ro.observe(root);
    return () => ro.disconnect();
  }, []);

  const scrollTop = (pos: Pos) => {
    if (!geo) return 0;
    const end = Math.max(0, geo.height - geo.view);
    return pos === "end" ? end : Math.min(end, Math.max(0, geo.tops[pos] - SCROLL_MARGIN));
  };

  // The same position rules as the real thread map.
  const top = scrollTop(view);
  const atEnd = geo ? top + geo.view >= geo.height - 2 : true;
  const current = !geo || atEnd ? TURNS.length - 1 : currentTurnIndex(geo.tops, top + geo.view * 0.3);
  const visible = geo ? visibleTurns(geo.tops, geo.height, top, top + geo.view) : TURNS.map(() => false);

  return (
    <div className="ad-thread" ref={viewport}>
      <div
        ref={track}
        className="ad-track"
        data-moving={(placed.current && !reduced) || undefined}
        style={{ transform: `translateY(${-scrollTop(at)}px)` }}
      >
        {TURNS.map((turn, i) => (
          <div key={i} className="ad-turn">
            <div className="ad-user" data-turn={i}>
              <div className="ad-bubble">
                {turn.bar ? <Bar w={turn.bar} h={7} r={3.5} tone={4} /> : turn.prompt}
              </div>
            </div>
            <AnswerBlock answer={turn.answer} />
          </div>
        ))}
        <div className="ad-footer-space" />
      </div>

      <div className="ad-map" data-target="rail">
        <div className="ad-ticks">
          {TURNS.map((_, i) => (
            <span key={i} className="ad-tick" data-state={i === current ? "current" : visible[i] ? "visible" : undefined} />
          ))}
        </div>
      </div>

      <Popover show={open} origin="right center" className="ad-panel">
        {TURNS.map((turn, i) => (
          <div key={i} className="ad-row" data-target={`row-${i}`} data-current={i === current || undefined}>
            <span className="ad-dot" />
            <span className="ad-label">{turn.prompt}</span>
          </div>
        ))}
      </Popover>
    </div>
  );
}

function AnswerBlock({ answer }: { answer: Answer }) {
  if ("prose" in answer) return <p className="ad-prose">{answer.prose}</p>;
  return (
    <div className="ad-lines">
      {answer.lines.map((w, i) =>
        typeof w === "number" ? <span key={i} style={{ height: w }} /> : <Bar key={i} w={w} h={7} r={3.5} tone={2} />,
      )}
    </div>
  );
}
