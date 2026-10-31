/**
 * Stage display metadata shared by the HTML report and the cross-session
 * dashboard. The former learning cards were removed in v0.4: only the stage
 * titles and pipeline order remain here.
 */
import type { StageId } from './types'

/** Display title per stage. */
export const STAGE_CARD_TITLES: Record<StageId, string> = {
  roadmap: '路线图',
  S0: 'S0 立项',
  S1: 'S1 需求澄清',
  S2: 'S2 上下文',
  S3: 'S3 设计拆解',
  S4: 'S4 执行',
  S5: 'S5 验证',
  S6: 'S6 交付',
  archived: '归档',
}

/** Pipeline order used by stage chips in the report/dashboard. */
export const STAGE_CARD_ORDER: StageId[] = ['roadmap', 'S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'archived']
