/**
 * Gate check outcome helpers shared inside the risk module.
 * Kept local (not imported from another owner's scope) so the module compiles and
 * tests independently while the rest of `src/core` is being written in parallel.
 */
import type { CheckOutcome } from '../types'

export function checkOutcome(input: CheckOutcome): CheckOutcome {
  const outcome: CheckOutcome = {
    item: input.item,
    label: input.label,
    passed: input.passed,
  }
  if (input.hint !== undefined) outcome.hint = input.hint
  if (input.example !== undefined) outcome.example = input.example
  if (input.details !== undefined && input.details.length > 0) outcome.details = input.details
  if (input.priority !== undefined) outcome.priority = input.priority
  return outcome
}
