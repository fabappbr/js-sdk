/**
 * Money and dates in the app's own currency and locale, not the viewer's.
 *
 * Both defaults here were real bugs. Passing `undefined` as the locale to `Intl` means "whatever the runtime is",
 * i.e. the VISITOR's browser — so a Brazilian app opened in an en-US browser printed `R$4,500.00`: the right symbol
 * with the wrong separators, which reads as sloppy rather than broken. And `new Date("2026-03-02")` parses a
 * date-only string as UTC midnight, which is the day before anywhere west of Greenwich; a due date on the 2nd showed
 * as the 1st for every user in the Americas while the stored value was perfectly correct.
 */
export type FormatConfig = { currency?: string; locale?: string };

/** A date with no time carries no timezone either, so it must be read as LOCAL midnight. A full timestamp is left alone. */
function parseDate(value: string | number): Date {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00`)
    : new Date(value);
}

export function createFormat(config: FormatConfig) {
  // An empty locale means "follow the browser", which `Intl` spells as `undefined`.
  const locale = () => config.locale || undefined;

  const formatDate = (value: Date | string | number, opts?: Intl.DateTimeFormatOptions): string => {
    const date = value instanceof Date ? value : parseDate(value);
    if (isNaN(date.getTime())) return "";
    try { return new Intl.DateTimeFormat(locale(), opts || { dateStyle: "short" }).format(date); }
    catch { return date.toISOString().slice(0, 10); }
  };

  return {
    /** Pass `currency` to override the app's own — for a record that carries a currency of its own. */
    formatMoney(value: number, currency?: string): string {
      const code = (currency || config.currency || "USD").toUpperCase();
      try { return new Intl.NumberFormat(locale(), { style: "currency", currency: code }).format(value); }
      catch { return `${code} ${Number(value).toFixed(2)}`; }
    },
    formatDate,
    formatDateTime: (value: Date | string | number, opts?: Intl.DateTimeFormatOptions): string =>
      formatDate(value, opts || { dateStyle: "short", timeStyle: "short" }),
  };
}
