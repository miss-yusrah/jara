import { after } from 'next/server'
import { checkAutoPay } from './auto-pay'
import { MoneyBusyError } from './money-lock'
import { getUserById } from './users'

/** Start promptly without making a deposit/move/chat response wait on a provider. */
export function scheduleAutoPay(userId: string) {
  after(async () => {
    try {
      const user = await getUserById(userId)
      if (user) await checkAutoPay(user)
    } catch (err) {
      // The minute sweep retries from persistent settings and payment journals.
      if (!(err instanceof MoneyBusyError)) console.warn('[auto-pay] background check deferred', userId)
    }
  })
}
