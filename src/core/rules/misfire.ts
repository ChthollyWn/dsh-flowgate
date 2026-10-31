/**
 * M-5 误判率驱动的规则自动降级（README FAQ：误判率超过 5% 的规则自动降为提示并进入复盘）。
 *
 * 统计口径与 `metrics` 的 M-5 一致：
 * - 拦截 = 账本里的 `rule.denied` / `rule.human`；
 * - 误判 = 上述拦截，或 `override.granted` / `exception.added` 中带 `misjudged` 标记、
 *   `reasonKind: 'misjudged'`、或理由含「误判」的记录。
 *
 * 样本不足（< {@link MISFIRE_MIN_SAMPLES}）时不降级：新规则被一两次误判放倒比误拦更危险。
 * 纯函数，方便单测与面板复用。
 */

/** 每条规则的误判反馈样本。 */
export interface RuleFeedback {
  /** 该规则的拦截次数（rule.denied + rule.human）。 */
  interceptions: number
  /** 其中被负责人标为误判的次数（含对应的放行/例外记录）。 */
  misjudged: number
}

/** 误判率目标（README：M-5 ≤ 5%）。 */
export const MISFIRE_RATE_TARGET = 0.05

/** 低于该样本量不做自动降级（避免噪声）。 */
export const MISFIRE_MIN_SAMPLES = 20

/** 误判率；没有拦截记录时返回 null（未知）。 */
export function ruleMisfireRate(feedback: RuleFeedback | undefined): number | null {
  if (!feedback || feedback.interceptions <= 0) return null
  return feedback.misjudged / feedback.interceptions
}

/** 是否应把该规则从 deny/human 降为提示（仅本次放行 + 记账）。 */
export function shouldDowngradeRule(feedback: RuleFeedback | undefined): boolean {
  if (!feedback) return false
  if (feedback.interceptions < MISFIRE_MIN_SAMPLES) return false
  return feedback.misjudged / feedback.interceptions > MISFIRE_RATE_TARGET
}
