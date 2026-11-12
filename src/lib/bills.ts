import { formatEther } from 'viem'
import {
  DISCO_INFO,
  NETWORK_INFO,
  detectNetwork,
  formatNgn,
  formatPhone,
  formatToken,
  isDisco,
  isMeterType,
  isNetwork,
  normalizeMeterNumber,
  normalizePhone,
  type Network,
} from './catalog'
import { CELOSCAN_TX, sendGdFromAgent, sendGdFromTreasury, treasuryAddress } from './chain'
import { serverConfig } from './env'
import { creditJar, debitJars, getJars, markJarPaid, syncJars, withUserLock } from './jars'
import { gdForNgn } from './price'
import { getTopupProvider } from './providers'
import { JAR_INFO, logActivity, updateActivity, type PendingAction, type User } from './users'
import { decryptAgentKey } from './wallets'

export interface BillResult {
  ok: boolean
  pending?: boolean
  message: string
  token?: string
  txHash?: string
  explorerUrl?: string
}

const allowTestNumbers = () => serverConfig().provider === 'mock' || serverConfig().vtpass.env === 'sandbox'

/**
 * Fill in and check a bill before showing it to the user for confirmation.
 * Returns a complete PendingAction, or an error the agent can relay.
 */
export async function prepareBill(
  user: User,
  draft: Omit<PendingAction, 'createdAt'>,
): Promise<{ action: PendingAction } | { error: string }> {
  if (!serverConfig().billsLive) {
    return { error: "I can't pay bills just yet. For now I save your G$, collect rewards, and Jara AI can help with research, assignments and more." }
  }
  const { maxBillNgn } = serverConfig().limits
  const amount = Math.round(draft.amountNgn)
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'How much should I pay? Give me an amount in naira.' }

  const jars = await getJars(user.id)
  const d = jars.find((j) => j.kind === draft.kind)!.details
  // "for me" with no number: use whichever jar already knows the user's phone.
  const savedPhone = d.phone ?? jars.find((j) => j.details.phone)?.details.phone
  const action: PendingAction = { ...draft, amountNgn: amount, createdAt: Date.now() }

  if (draft.kind === 'airtime' || draft.kind === 'data') {
    const phone = normalizePhone(draft.phone ?? savedPhone ?? '', allowTestNumbers())
    if (!phone) return { error: 'Which phone number? Send it like 0803 123 4567.' }
    const network = (isNetwork(draft.network) ? draft.network : null) ?? detectNetwork(phone) ?? (jars.find((j) => j.details.phone === phone && isNetwork(j.details.network))?.details.network as Network | undefined) ?? null
    if (!network) return { error: `Which network is ${formatPhone(phone)} on — MTN, Airtel, Glo or 9mobile?` }
    action.phone = phone
    action.network = network
    if (draft.kind === 'airtime' && amount < 50) return { error: 'Airtime starts from ₦50.' }
    if (draft.kind === 'data') {
      const plans = await getTopupProvider().listDataPlans(network)
      const byCode = draft.planCode ? plans.find((p) => p.code === draft.planCode) : undefined
      const affordable = plans.filter((p) => p.amountNgn <= amount)
      const plan = byCode ?? matchPlanName(plans, draft.planName) ?? affordable[affordable.length - 1]
      if (!plan) return { error: `The cheapest ${NETWORK_INFO[network].label} data plan is ${formatNgn(plans[0]?.amountNgn ?? 0)}.` }
      action.planCode = plan.code
      action.planName = plan.name
      action.amountNgn = plan.amountNgn
    }
  }

  if (draft.kind === 'light') {
    const disco = draft.disco ?? d.disco
    const meterType = draft.meterType ?? d.meterType ?? 'prepaid'
    const meter = normalizeMeterNumber(draft.meterNumber ?? d.meterNumber ?? '')
    if (!isDisco(disco) || !meter || !isMeterType(meterType)) {
      return { error: 'I need your meter details first. Set up your Light jar in the app (meter number + electricity company).' }
    }
    if (amount < DISCO_INFO[disco].minNgn) return { error: `${DISCO_INFO[disco].short} needs at least ${formatNgn(DISCO_INFO[disco].minNgn)}.` }
    action.disco = disco
    action.meterType = meterType
    action.meterNumber = meter
  }
  if (action.amountNgn > maxBillNgn) return { error: `I can only pay up to ${formatNgn(maxBillNgn)} at once for now.` }
  return { action }
}

function matchPlanName<T extends { name: string }>(plans: T[], name?: string): T | undefined {
  if (!name) return undefined
  const size = name.toLowerCase().replace(/\s+/g, '').match(/(\d+(?:\.\d+)?)(gb|mb)/)
  if (!size) return undefined
  return plans.find((p) => p.name.toLowerCase().replace(/\s+/g, '').includes(`${size[1]}${size[2]}`))
}

export function describeAction(a: PendingAction): string {
  switch (a.kind) {
    case 'airtime':
      return `${formatNgn(a.amountNgn)} ${NETWORK_INFO[a.network as Network]?.label ?? ''} airtime to ${formatPhone(a.phone ?? '')}`
    case 'data':
      return `${a.planName} ${NETWORK_INFO[a.network as Network]?.label ?? ''} data (${formatNgn(a.amountNgn)}) to ${formatPhone(a.phone ?? '')}`
    case 'light':
      return `${formatNgn(a.amountNgn)} electricity for meter ${a.meterNumber} (${isDisco(a.disco) ? DISCO_INFO[a.disco].short : a.disco})`
  }
}

/** Pay a confirmed bill: G$ from the jar → treasury on Celo, then the bill through the top-up provider. */
export async function payBill(user: User, action: PendingAction): Promise<BillResult> {
  return withUserLock(user.id, async () => {
    await syncJars(user)
    const needed = await gdForNgn(action.amountNgn)
    const gdText = `G$ ${Number(formatEther(needed)).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    const fromJar = (await getJars(user.id)).find((j) => j.kind === action.kind)!.balanceWei >= needed
    const source = fromJar ? `your ${JAR_INFO[action.kind].label} jar` : 'your jars'
    if (!(await debitJars(user, action.kind, needed))) {
      return { ok: false, message: `Not enough G$ yet — this needs ${gdText}. Your jars will fill as I claim each day, or you can deposit G$.` }
    }

    let txHash: string
    try {
      txHash = await sendGdFromAgent(decryptAgentKey(user.agentKeyEnc), treasuryAddress(), needed)
    } catch (err) {
      await creditJar(user.id, action.kind, needed)
      console.error('[bills] G$ transfer failed', err)
      return { ok: false, message: 'I could not move your G$ just now. Nothing was spent — try again in a minute.' }
    }

    const title = describeAction(action)
    const activityId = await logActivity(user.id, {
      type: 'pay',
      jar: action.kind,
      amountWei: needed.toString(),
      amountNgn: action.amountNgn,
      txHash,
      status: 'pending',
      title: `Paying ${title}`,
    })

    const provider = getTopupProvider()
    const reference = provider.createReference()
    const phone = action.phone ?? (await getJars(user.id)).find((j) => j.kind === 'light')?.details.phone ?? '08011111111'
    let result
    try {
      if (action.kind === 'airtime') {
        result = await provider.buyAirtime({ network: action.network as Network, phone: action.phone!, amount: action.amountNgn, reference })
      } else if (action.kind === 'data') {
        result = await provider.buyData({ network: action.network as Network, phone: action.phone!, planCode: action.planCode!, amount: action.amountNgn, reference })
      } else {
        result = await provider.buyElectricity({
          disco: action.disco as never,
          meterType: action.meterType as never,
          meterNumber: action.meterNumber!,
          phone,
          amount: action.amountNgn,
          reference,
        })
      }
    } catch (err) {
      console.error('[bills] provider error', err)
      result = { state: 'pending' as const, reference }
    }

    const explorerUrl = serverConfig().chain.mode === 'celo' ? CELOSCAN_TX(txHash) : undefined

    if (result.state === 'success') {
      await markJarPaid(user.id, action.kind)
      const token = result.token ? formatToken(result.token) : undefined
      await updateActivity(activityId, {
        status: 'done',
        title: `Paid ${title}`,
        detail: token ? `Token: ${token}${result.units ? ` · ${result.units}` : ''}` : `${gdText} from ${source}`,
      })
      return {
        ok: true,
        message: `Done ✅ ${title}. Paid with ${gdText} from ${source}.${token ? `\n\n🔑 Token: ${token}` : ''}`,
        token,
        txHash,
        explorerUrl,
      }
    }

    if (result.state === 'failed') {
      let refundHash: string | undefined
      try {
        refundHash = await sendGdFromTreasury(user.agentAddress, needed)
        await creditJar(user.id, action.kind, needed)
      } catch (err) {
        console.error('[bills] REFUND FAILED — handle manually', user.id, needed.toString(), err)
      }
      await updateActivity(activityId, { status: 'failed', title: `Failed: ${title}`, detail: result.message ?? null })
      await logActivity(user.id, { type: 'refund', jar: action.kind, amountWei: needed.toString(), txHash: refundHash, title: `Refunded ${gdText}` })
      return { ok: false, message: `That didn't go through (${result.message ?? 'provider declined'}). I've put your ${gdText} back.` }
    }

    await updateActivity(activityId, { detail: `Reference ${reference} — still processing` })
    return { ok: true, pending: true, message: `Your ${title} is processing. I'll keep checking.`, txHash, explorerUrl }
  })
}
