/** ask_user_question 问答提取（T2.2，H13 参数形状容错）。 */
import { describe, expect, it } from 'vitest'
import { clarifyQuestionFromTool } from '../../src/host/evidence/index.js'

describe('clarifyQuestionFromTool', () => {
  it('解析 questions:[{question, options}] 与 options:[{label}]', () => {
    expect(
      clarifyQuestionFromTool('ask_user_question', {
        questions: [{ question: '续费从哪天算？', options: [{ label: '当天' }, { label: '次日' }] }],
      }),
    ).toEqual({ question: '续费从哪天算？', options: ['当天', '次日'] })
  })

  it('兼容扁平 {question, options:[string]}', () => {
    expect(clarifyQuestionFromTool('ask_user_question', { question: '用哪种方案？', options: ['A', 'B'] })).toEqual({
      question: '用哪种方案？',
      options: ['A', 'B'],
    })
  })

  it('非 ask_user_question 工具或空问题返回 null', () => {
    expect(clarifyQuestionFromTool('bash', { question: 'x' })).toBeNull()
    expect(clarifyQuestionFromTool('ask_user_question', {})).toBeNull()
    expect(clarifyQuestionFromTool('ask_user_question', { questions: [{ options: ['A'] }] })).toBeNull()
  })
})
