export const DEFAULT_TIMEZONE = "Asia/Ho_Chi_Minh";
/** Fixed offset of the default timezone (no DST), used to build ISO instants. */
const DEFAULT_OFFSET = "+07:00";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})$/;

export function isDateOnly(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

/** "2026-10-22 09:00" or "2026-10-22T09:00" → ISO with the +07:00 offset, or null. */
export function localDateTimeToIso(value: string): string | null {
  const m = DATETIME_RE.exec(value.trim());
  if (!m || !isDateOnly(m[1] as string)) return null;
  const [h, min] = (m[2] as string).split(":").map(Number) as [number, number];
  if (h > 23 || min > 59) return null;
  return `${m[1]}T${m[2]}:00${DEFAULT_OFFSET}`;
}

/** Instant → "dd/MM/yyyy HH:mm" in the personal timezone. */
export function formatInstant(iso: string, timeZone: string = DEFAULT_TIMEZONE): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("day")}/${g("month")}/${g("year")} ${g("hour")}:${g("minute")}`;
}

/** "2026-10-22" → "22/10/2026". */
export function formatDate(value: string): string {
  return DATE_RE.test(value) ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}` : value;
}

/** Accept dd/MM/yyyy or yyyy-MM-dd, return yyyy-MM-dd or null. */
export function parseDateInput(value: string): string | null {
  const v = value.trim();
  const vn = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  const iso = vn ? `${vn[3]}-${(vn[2] as string).padStart(2, "0")}-${(vn[1] as string).padStart(2, "0")}` : v;
  return isDateOnly(iso) ? iso : null;
}
