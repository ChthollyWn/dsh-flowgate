/**
 * English dictionary. Kept key-identical to `zh.ts` (a unit test enforces the
 * parity); the data lives in `../locale/en.json`.
 */
import raw from '../locale/en.json'
import type { MessageKey } from './zh'

export const DICT_EN = raw
export type EnDict = typeof DICT_EN
export default DICT_EN

/** Compile-time hint that keeps `MessageKey` importable from either file. */
export type { MessageKey }
