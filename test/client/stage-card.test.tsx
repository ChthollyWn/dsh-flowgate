/** SSR tests for the seven-stage learning cards (T5.2 / FR-8.3). */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StageCard } from '../../src/client/learn/StageCard'
import { cardsFor, isLearningStage, LEARNING_STAGES, STAGE_CARDS, visibleParts } from '../../src/client/learn/cards'
import { createTranslator } from '../../src/client/i18n'
import { stageCardFor } from '../../src/client/model'

const zh = createTranslator('zh')
const en = createTranslator('en')

function render(mode: 'detail' | 'brief' | 'off', checks?: { label: string; passed: boolean }[]): string {
  const card = cardsFor('zh').S3
  return renderToStaticMarkup(
    <StageCard stage="S3" stageLabel="设计拆解" index="③" card={card} mode={mode} t={zh} checks={checks} />,
  )
}

describe('StageCard', () => {
  it('detail mode shows all six parts plus the good/bad examples', () => {
    const html = render('detail')
    for (const part of ['what', 'why', 'criteria', 'artifacts', 'upstream', 'antipatterns', 'good', 'bad']) {
      expect(html).toContain(`data-flowgate="stage-card-${part}"`)
    }
    expect(html).toContain('做什么')
    expect(html).toContain('为什么')
    expect(html).toContain('合格标准')
    expect(html).toContain('产物')
    expect(html).toContain('方法来源')
    expect(html).toContain('常见反模式')
    expect(html).toContain('Superpowers writing-plans')
    expect(html).toContain('data-learning-mode="detail"')
  })

  it('brief mode keeps what / why / criteria / artifacts but drops long-form parts', () => {
    const html = render('brief')
    expect(html).toContain('data-flowgate="stage-card-what"')
    expect(html).toContain('data-flowgate="stage-card-why"')
    expect(html).toContain('data-flowgate="stage-card-criteria"')
    expect(html).toContain('data-flowgate="stage-card-artifacts"')
    expect(html).not.toContain('data-flowgate="stage-card-upstream"')
    expect(html).not.toContain('data-flowgate="stage-card-antipatterns"')
    expect(html).not.toContain('data-flowgate="stage-card-good"')
  })

  it('off mode only keeps the artifacts line', () => {
    const html = render('off')
    expect(html).toContain('data-flowgate="stage-card-artifacts"')
    expect(html).not.toContain('data-flowgate="stage-card-what"')
    expect(html).not.toContain('data-flowgate="stage-card-criteria"')
  })

  it('renders live gate checks with ✓ / ✗ instead of the static criteria list', () => {
    const html = render('detail', [
      { label: '设计里有 2–3 个方案对比', passed: true },
      { label: '场景 R2.S3 没有任务覆盖', passed: false },
    ])
    expect(html).toContain('data-flowgate="stage-card-live-checks"')
    expect(html).toContain('data-check-passed="true"')
    expect(html).toContain('data-check-passed="false"')
    expect(html).toContain('✓')
    expect(html).toContain('✗')
    expect(html).not.toContain('data-flowgate="stage-card-criteria"')
  })

  it('carries an accessible label for the stage card', () => {
    expect(render('detail')).toContain('aria-label="设计拆解 阶段卡"')
  })
})

describe('learning card content (T5.2 acceptance)', () => {
  it('covers all seven pipeline stages in both languages', () => {
    expect(LEARNING_STAGES).toHaveLength(7)
    for (const locale of ['zh', 'en'] as const) {
      for (const stage of LEARNING_STAGES) {
        const card = STAGE_CARDS[locale][stage]
        expect(card, `${locale}/${stage}`).toBeDefined()
        expect(card.what.length).toBeGreaterThan(10)
        expect(card.why.length).toBeGreaterThan(10)
        expect(card.criteria.length).toBeGreaterThan(0)
        expect(card.artifacts.length).toBeGreaterThan(0)
        expect(card.upstream.length).toBeGreaterThan(5)
        expect(card.antiPatterns.length).toBeGreaterThan(0)
        expect(card.good.length).toBeGreaterThan(10)
        expect(card.bad.length).toBeGreaterThan(10)
        // No placeholder text left over.
        expect(card.what).not.toContain('TODO')
        expect(card.criteria.every((criterion) => criterion.trim().length > 3)).toBe(true)
      }
      expect(isLearningStage('S4')).toBe(true)
      expect(isLearningStage('roadmap')).toBe(false)
    }
  })

  it('renders six parts for every stage in detail mode', () => {
    for (const stage of LEARNING_STAGES) {
      const t = zh
      const card = cardsFor('zh')[stage]
      const html = renderToStaticMarkup(
        <StageCard stage={stage} stageLabel={stage} card={card} mode="detail" t={t} />,
      )
      for (const part of ['what', 'why', 'criteria', 'artifacts', 'upstream', 'antipatterns']) {
        expect(html, `${stage}/${part}`).toContain(`data-flowgate="stage-card-${part}"`)
      }
    }
  })

  it('projects the stage selection to the right card', () => {
    expect(stageCardFor('S3', zh).what).toContain('方案对比')
    expect(stageCardFor('S6', zh).what).toContain('交付')
    expect(stageCardFor('S6', en).what).toContain('delivery report')
  })

  it('visibleParts reports the three learning modes consistently', () => {
    expect(visibleParts('detail')).toMatchObject({ upstream: true, antiPatterns: true, examples: true })
    expect(visibleParts('brief')).toMatchObject({ upstream: false, antiPatterns: false, examples: false })
    expect(visibleParts('off')).toMatchObject({ what: false, artifacts: true, examples: false })
  })
})
