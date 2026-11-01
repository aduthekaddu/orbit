import { startOfDay } from "./chat-groups";

export function msUntilNextMidnight(now: number) {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime() - now;
}

export function todaySnapshot() {
  return startOfDay(new Date());
}

export function serverTodaySnapshot() {
  return null;
}

export function subscribeToday(onChange: () => void) {
  let timer: ReturnType<typeof setTimeout>;
  const waitForMidnight = () => {
    timer = setTimeout(() => {
      onChange();
      waitForMidnight();
    }, msUntilNextMidnight(Date.now()));
  };
  waitForMidnight();
  return () => clearTimeout(timer);
}
