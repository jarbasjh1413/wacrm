import type { Locale } from 'date-fns'
import { enUS, ko, ptBR } from 'date-fns/locale'

// Single source of truth for locale-sensitive formatting. The app locale
// comes from NEXT_PUBLIC_APP_LOCALE (same env var the i18n dictionary uses),
// so dates/numbers always match the UI language instead of the browser or
// server default.
const appLocale = process.env.NEXT_PUBLIC_APP_LOCALE || 'en'

/** BCP-47 tag for Intl APIs (toLocaleDateString, Intl.NumberFormat, …). */
export const INTL_LOCALE =
  appLocale === 'pt' ? 'pt-BR' : appLocale === 'ko' ? 'ko-KR' : 'en-US'

/** Matching date-fns locale for format()/formatDistanceToNow(). */
export const DATE_FNS_LOCALE: Locale =
  appLocale === 'pt' ? ptBR : appLocale === 'ko' ? ko : enUS

/** 31/07/2026 (pt) · 7/31/2026 (en) */
export function formatShortDate(date: Date | string | number): string {
  return new Date(date).toLocaleDateString(INTL_LOCALE)
}

/** 31 de jul. de 2026 (pt) · Jul 31, 2026 (en) */
export function formatMediumDate(date: Date | string | number): string {
  return new Date(date).toLocaleDateString(INTL_LOCALE, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/** 31 de jul. de 2026, 14:05 (pt) · Jul 31, 2026, 2:05 PM (en) */
export function formatMediumDateTime(date: Date | string | number): string {
  return new Date(date).toLocaleString(INTL_LOCALE, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 31/07/2026, 14:05:12 (pt) — full timestamp for logs/recipient tables. */
export function formatFullDateTime(date: Date | string | number): string {
  return new Date(date).toLocaleString(INTL_LOCALE)
}
