/**
 * Pure cron scheduling utilities used by the cron-trigger layer.
 *
 * Two exported functions:
 *  - validateCronExpr: returns true iff the expression is a non-empty string
 *    that is parseable by cron-parser.
 *  - occurrencesBetween: enumerates all fire times in the half-open interval
 *    (after, now], oldest first.  Returns [] on an invalid expression.
 *
 * No state, no I/O — safe to call from any context.
 */

import { CronExpressionParser } from 'cron-parser'

/**
 * Returns true if expr is a non-empty valid cron expression that cron-parser
 * can parse.  An empty string is always invalid.
 */
export function validateCronExpr(expr: string): boolean {
  if (expr.trim() === '') return false
  try {
    CronExpressionParser.parse(expr)
    return true
  } catch {
    return false
  }
}

/**
 * Returns all fire times of expr in the half-open interval (after, now],
 * oldest first.  Empty array on an invalid or empty expression.
 *
 * @param expr  - Standard 5-field cron expression (minute hour dom month dow).
 * @param after - Exclusive lower bound as epoch ms.
 * @param now   - Inclusive upper bound as epoch ms.
 */
export function occurrencesBetween(expr: string, after: number, now: number): number[] {
  const MAX_ITERATIONS = 1000
  const results: number[] = []

  if (expr.trim() === '') return []

  let it
  try {
    it = CronExpressionParser.parse(expr, { currentDate: new Date(after) })
  } catch {
    return []
  }

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const t = it.next().getTime()
    if (t > now) break
    results.push(t)
  }

  return results
}
