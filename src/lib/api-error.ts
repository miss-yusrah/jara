import { NextResponse } from 'next/server'
import { MoneyBusyError } from './money-lock'

/** Never turn an unknown payment outcome into a claimed failure or a new charge. */
export function apiFailure(error: unknown, context: string) {
  if (error instanceof MoneyBusyError) {
    return NextResponse.json({ error: 'Jara is still processing another request on your account. Please retry this same request shortly.', code: 'operation_busy', retryable: true }, { status: 409 })
  }
  console.error(`[${context}] request failed`, error instanceof Error ? error.name : 'UnknownError')
  return NextResponse.json({ error: 'Jara could not confirm the result yet. If this was a payment, retry this same request to check its status.', code: 'service_unavailable', retryable: true }, { status: 503 })
}
