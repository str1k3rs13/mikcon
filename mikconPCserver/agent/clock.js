// Injectable clock. Every time-dependent thing in agent/ takes one of these, so a test can
// place "now" precisely instead of sleeping — a year of billing dates then runs in
// milliseconds. Plain Node: no Electron, no dependencies.

// A PC booting with a dead RTC reads 1970. Acting on that date would, once the ladder exists,
// text every customer that they are 20,000 days overdue. Same guard test/counters.mjs uses.
export const MIN_SANE_YEAR = 2024;

// LOCAL time, deliberately. The app's own todayYmd() is local, and in UTC+8 a UTC-based
// version reads as the previous day all early morning — filing an early-morning collection
// under yesterday.
export function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function makeClock(nowFn = () => new Date()) {
  return {
    now: () => nowFn(),
    today: () => ymd(nowFn()),
    isSane: () => nowFn().getFullYear() >= MIN_SANE_YEAR,
  };
}
