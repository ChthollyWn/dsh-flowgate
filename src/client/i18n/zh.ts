/**
 * Chinese dictionary (default locale), typed so `MessageKey` can be derived
 * from it. The data itself lives in `../locale/zh.json` (hand-editable, plain
 * JSON) — this module is the typed binding the rest of the bundle imports.
 */
import raw from '../locale/zh.json'

export const DICT_ZH = raw
export type ZhDict = typeof DICT_ZH
export type MessageKey = keyof ZhDict
export default DICT_ZH
