/**
 * Stage display metadata used by the graphical surfaces (FlowMap artifact
 * chips, i18n key coverage). The former learning cards/mode were removed:
 * only the operational artifact names remain here.
 */
import type { Locale } from './i18n'

export type PipelineStageId = 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6'

export const PIPELINE_STAGES: PipelineStageId[] = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6']

export const STAGE_ARTIFACTS: Record<Locale, Record<PipelineStageId, string[]>> = {
  zh: {
    S0: ['proposal.md', 'status.json'],
    S1: ['clarify.md', 'proposal.md', 'spec.md（增量）'],
    S2: ['context.md', 'project.md', '基线证据回执'],
    S3: ['design.md', 'risk.md', 'tasks.md', 'execution-plan.md'],
    S4: ['变更分支上的提交', '证据回执', 'review.md'],
    S5: ['验证回执', '终审记录', '回归对比'],
    S6: ['report.html', 'PR 描述 / 提交说明', '归档后的 specs'],
  },
  en: {
    S0: ['proposal.md', 'status.json'],
    S1: ['clarify.md', 'proposal.md', 'spec.md (incremental)'],
    S2: ['context.md', 'project.md', 'baseline evidence receipt'],
    S3: ['design.md', 'risk.md', 'tasks.md', 'execution-plan.md'],
    S4: ['commits on the change branch', 'evidence receipts', 'review.md'],
    S5: ['verification receipts', 'final review record', 'regression comparison'],
    S6: ['report.html', 'PR description / commit message', 'merged specs after archive'],
  },
}

/** Artifact chips for one stage, localized; unknown stages degrade to S0. */
export function artifactsForStage(stage: string | undefined, locale: Locale): string[] {
  const key = stage !== undefined && (PIPELINE_STAGES as string[]).includes(stage) ? (stage as PipelineStageId) : 'S0'
  return STAGE_ARTIFACTS[locale]?.[key] ?? STAGE_ARTIFACTS.zh[key]
}
