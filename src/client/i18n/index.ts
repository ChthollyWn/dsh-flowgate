/**
 * FlowGate client i18n.
 *
 * The dictionaries live in `src/client/locale/{zh,en}.json` (plain data, easy
 * to diff / hand to translators) and are typed through `i18n/zh.ts` +
 * `i18n/en.ts`. Chinese is the default; English is complete. Every
 * user-visible string in this bundle goes through `t(...)`.
 */
import { DICT_ZH } from './zh'
import { DICT_EN } from './en'
import type { MessageKey } from './zh'

export type { MessageKey }
export type Locale = 'zh' | 'en'
export type TranslateParams = Record<string, string | number>
export type TFn = (key: MessageKey, params?: TranslateParams) => string

export const DICTS: Record<Locale, Record<string, string>> = {
  zh: DICT_ZH as Record<string, string>,
  en: DICT_EN as Record<string, string>,
}

export const DEFAULT_LOCALE: Locale = 'zh'

/** Replace `{name}` placeholders; unknown params stay verbatim. */
export function format(template: string, params?: TranslateParams): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/**
 * Build a translator for a locale. Missing keys fall back to the Chinese
 * dictionary and then to the raw key so a host that delivers an older/newer
 * dictionary never crashes a render.
 */
export function createTranslator(locale: Locale = DEFAULT_LOCALE): TFn {
  const dict = DICTS[locale] ?? DICTS.zh
  return (key: MessageKey, params?: TranslateParams): string => {
    const template = dict[key] ?? DICTS.zh[key] ?? String(key)
    return format(template, params)
  }
}

/** Coerce an unknown locale value (host / projection) to a known locale. */
export function normalizeLocale(value: unknown): Locale {
  return value === 'en' ? 'en' : 'zh'
}

/** Read the active locale out of a bound translator (reactively at render time). */
export function localeOf(t: TFn): Locale {
  try {
    return normalizeLocale(t('meta.locale'))
  } catch {
    return DEFAULT_LOCALE
  }
}

/** Structural fallback translator used when the host locale seat is missing. */
export function fallbackTranslator(): TFn {
  return createTranslator(DEFAULT_LOCALE)
}
