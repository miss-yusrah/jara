import { NextResponse } from 'next/server'
import { apiFailure } from '../api-error'
import { StreakError } from './service'

/** Say what happened in JSON; unknown failures go through the shared handler. */
export function streakFailure(err: unknown, context: string) {
  if (err instanceof StreakError) {
    return NextResponse.json({ error: err.message, code: err.code, retryable: err.status >= 500 }, { status: err.status })
  }
  if (err instanceof Error && /Connect your GoodDollar account first|wallet link has changed/.test(err.message)) {
    return NextResponse.json({ error: err.message, code: 'not_connected' }, { status: 409 })
  }
  return apiFailure(err, context)
}
