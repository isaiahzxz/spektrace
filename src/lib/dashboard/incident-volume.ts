export type VolumeRange = "day" | "week" | "month";

export type DayVolume = {
  day: string;
  count: number;
};

export type VolumePoint = {
  /** Exact bucket, used in the tooltip. */
  label: string;
  /** Short x-axis tick. Empty when this bucket is unlabeled. */
  axis: string;
  count: number;
};

export type VolumeWindow = {
  start: Date;
  days: string[];
};

function utcParts(value: Date) {
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth(),
    day: value.getUTCDate(),
  };
}

function isoDay(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month, day));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Inclusive UTC dates ending on `now`, oldest first. */
export function volumeWindow(now: Date, days = 8): VolumeWindow {
  const count = Math.max(1, days);
  const { year, month, day } = utcParts(now);
  const keys: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    keys.push(isoDay(year, month, day - offset));
  }
  const [y, m, d] = keys[0].split("-").map(Number);
  return { start: new Date(Date.UTC(y, m - 1, d)), days: keys };
}

export function storedIncidentVolume(stamps: Date[], window: VolumeWindow): DayVolume[] {
  const counts = new Map(window.days.map((day) => [day, 0]));
  for (const stamp of stamps) {
    const { year, month, day } = utcParts(stamp);
    const key = isoDay(year, month, day);
    if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return window.days.map((day) => ({ day, count: counts.get(day) ?? 0 }));
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekday(isoDay: string) {
  const [year, month, day] = isoDay.split("-").map(Number);
  return WEEKDAY[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? "";
}

/** Captured-incident counts for the chart. Day is hourly UTC; week and month are UTC dates. */
export function capturedSeries(stamps: Date[], now: Date, range: VolumeRange): {
  start: Date;
  startLabel: string;
  endLabel: string;
  points: VolumePoint[];
} {
  if (range === "day") {
    const endHour = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours());
    const buckets = Array.from({ length: 24 }, (_, index) => {
      const at = new Date(endHour - (23 - index) * 3_600_000);
      return { key: at.toISOString().slice(0, 13), label: at.toISOString().slice(11, 16), count: 0 };
    });
    const index = new Map(buckets.map((bucket, slot) => [bucket.key, slot]));
    for (const stamp of stamps) {
      const slot = index.get(stamp.toISOString().slice(0, 13));
      if (slot !== undefined) buckets[slot].count += 1;
    }
    return {
      start: new Date(endHour - 23 * 3_600_000),
      startLabel: `${buckets[0]?.key.replace("T", " ") ?? ""} UTC`,
      endLabel: `${buckets[buckets.length - 1]?.key.replace("T", " ") ?? ""} UTC`,
      points: buckets.map(({ label, count }, index) => ({
        label: `${label} UTC`,
        axis: index % 4 === 0 ? label : "",
        count,
      })),
    };
  }

  const window = volumeWindow(now, range === "week" ? 7 : 30);
  const days = storedIncidentVolume(stamps, window);
  return {
    start: window.start,
    startLabel: window.days[0] ?? "",
    endLabel: window.days[window.days.length - 1] ?? "",
    points: days.map((point, index) => ({
      label: `${point.day} UTC`,
      axis: range === "week" ? weekday(point.day) : index % 5 === 0 || index === days.length - 1 ? point.day.slice(5) : "",
      count: point.count,
    })),
  };
}

/** Buckets covering [start, endExclusive). Hourly when the span is 36 hours or less. */
export function seriesForInterval(stamps: Date[], start: Date, endExclusive: Date): VolumePoint[] {
  const span = endExclusive.getTime() - start.getTime();
  if (span <= 36 * 3_600_000) {
    const startHour = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), start.getUTCHours());
    const hours = Math.max(1, Math.ceil(span / 3_600_000));
    const buckets = Array.from({ length: hours }, (_, index) => {
      const at = new Date(startHour + index * 3_600_000);
      const label = at.toISOString().slice(11, 16);
      return { key: at.toISOString().slice(0, 13), label, count: 0 };
    });
    const index = new Map(buckets.map((bucket, slot) => [bucket.key, slot]));
    for (const stamp of stamps) {
      const slot = index.get(stamp.toISOString().slice(0, 13));
      if (slot !== undefined) buckets[slot].count += 1;
    }
    return buckets.map(({ label, count }, slot) => ({
      label: `${label} UTC`,
      axis: slot % 4 === 0 ? label : "",
      count,
    }));
  }

  const days: string[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(endExclusive.getTime() - 1);
  const endDay = Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate());
  while (cursor.getTime() <= endDay && days.length < 120) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const window = { start: new Date(days[0] ? `${days[0]}T00:00:00.000Z` : start), days };
  const counts = storedIncidentVolume(stamps, window);
  const step = counts.length > 14 ? 5 : 1;
  return counts.map((point, index) => ({
    label: `${point.day} UTC`,
    axis: index % step === 0 || (index === counts.length - 1 && index % step > 2) ? (counts.length <= 10 ? weekday(point.day) : point.day.slice(5)) : "",
    count: point.count,
  }));
}
