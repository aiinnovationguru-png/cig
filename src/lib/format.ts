const euroFormatter = new Intl.NumberFormat("it-IT", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

const compactFormatter = new Intl.NumberFormat("it-IT", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function euro(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return euroFormatter.format(value);
}

export function euroCompact(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `€ ${compactFormatter.format(value)}`;
}

export function num(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("it-IT").format(value);
}

export function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(digits).replace(".", ",")}%`;
}

export function dateIt(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return date.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export function dateTimeIt(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function daysLeft(value: string | null | undefined): number | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.ceil((date.getTime() - Date.now()) / 86_400_000);
}

export function kindLabel(kind: string): string {
  if (kind === "call") return "Bando";
  if (kind === "award") return "Aggiudicazione";
  return "Avviso";
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function daysAgo(days: number): string {
  return isoDate(new Date(Date.now() - days * 86_400_000));
}

export function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

export function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}
