'use client'

import { useState } from 'react'
import { CashOutButton, GoodCashProvider, type CashOutEvent, type TopUpEvent } from '@goodcash/react'
import { createWalletClient, custom, type EIP1193Provider } from 'viem'
import { celo } from 'viem/chains'
import { walletErrorMessage } from '@/lib/wallet-connect'
import { getWalletProvider, isMiniPay, isMobileBrowser } from '@/lib/web3auth'

// Cash G$ out to a Nigerian bank, or add G$ by paying naira, through GoodCash. Non-custodial: the
// person's own verified wallet signs one transaction; GoodCash never holds money or keys. Jara records
// the outcome from GoodCash's signed webhook (lib/goodcash.ts), not from these browser events.

const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_GOODCASH_KEY ?? ''

const THEME = {
  background: '#fff6e5',
  surface: '#ffffff',
  ink: '#0b1f16',
  accent: '#ff6b00',
  accentInk: '#ffffff',
  highlight: '#ffc72c',
  success: '#edf2e8',
  radius: 16,
  font: 'var(--font-bricolage), ui-sans-serif, system-ui, sans-serif',
  mode: 'light' as const,
}

const primary = 'app-button w-full justify-center bg-forest text-cream hover:bg-forest-soft disabled:opacity-60 min-h-12 text-sm'
const secondary = 'app-button-secondary w-full justify-center min-h-11 text-sm'

/** Only a publishable key may ever reach the browser. */
export function goodCashConfigured() {
  return PUBLISHABLE_KEY.startsWith('gc_pk_')
}

/**
 * The person's wallet, asked for only when they act (never on opening the profile), and only if it is
 * the verified GoodDollar wallet this account uses: otherwise G$ could leave the wrong wallet.
 */
async function verifiedWallet(root: `0x${string}`): Promise<EIP1193Provider> {
  const provider = await getWalletProvider()
  const [account] = await createWalletClient({ chain: celo, transport: custom(provider) }).requestAddresses()
  if (!account || account.toLowerCase() !== root.toLowerCase()) {
    throw new Error(`Switch to your verified GoodDollar wallet (${root.slice(0, 6)}…${root.slice(-4)}) to use GoodCash.`)
  }
  return provider
}

/**
 * The send function GoodCash calls with its one checked transaction. Before the wallet is asked,
 * Jara tops the wallet up with a little CELO for the network fee (from GoodDollar's faucet), so a
 * person with only G$ can still cash out.
 */
function verifiedSender(wallet: `0x${string}`, onError: (msg: string | null) => void) {
  return async (tx: { to: `0x${string}`; data: `0x${string}`; from: `0x${string}` }) => {
    onError(null)
    try {
      await fetch('/api/goodcash/gas', { method: 'POST', headers: { 'x-goodcash': '1' } }).catch(() => undefined)
      const provider = await verifiedWallet(wallet)
      const client = createWalletClient({ chain: celo, transport: custom(provider) })
      await client.switchChain({ id: celo.id }).catch(() => client.addChain({ chain: celo }))
      return await client.sendTransaction({ account: wallet, chain: celo, to: tx.to, data: tx.data, value: 0n })
    } catch (err) {
      onError(err instanceof Error && err.message.startsWith('Switch to your verified') ? err.message : walletErrorMessage(err))
      throw err
    }
  }
}

function cashOutEvents(flash: (t: string) => void, onError: (msg: string | null) => void) {
  return (e: CashOutEvent) => {
    if (e.type === 'cashout.sent') flash('Sent. Your bank is usually paid within minutes.')
    if (e.type === 'cashout.paid') flash('Paid to your bank 🎉')
    if (e.type === 'cashout.failed') onError('That cash out did not finish. Check your history before trying again.')
  }
}

/** Just the cash-out button (for example on a referral reward), prefilled with an amount. */
export function GoodCashCashOut({ userId, wallet, flash, amountG, label, className }: { userId: string; wallet: `0x${string}`; flash: (t: string) => void; amountG?: number; label: string; className?: string }) {
  const [error, setError] = useState<string | null>(null)
  if (!goodCashConfigured()) return null
  return (
    <GoodCashProvider publishableKey={PUBLISHABLE_KEY} theme={THEME}>
      <CashOutButton label={label} className={className ?? primary} signer={verifiedSender(wallet, setError)} wallet={wallet} partnerRef={userId}
        defaultAmountG={amountG && amountG > 0 ? Math.floor(amountG) : undefined} onEvent={cashOutEvents(flash, setError)} />
      {error && <p role="alert" className="mt-2 rounded-xl bg-[#fcf0e7] px-4 py-3 text-sm font-semibold text-ink">{error}</p>}
      <p className="mt-1 text-center text-[11px] font-semibold opacity-60">Powered by GoodCash</p>
    </GoodCashProvider>
  )
}

type Props = {
  userId: string
  /** The verified GoodDollar wallet (root). G$ is cashed out from, and topped up into, this wallet. */
  wallet: `0x${string}`
  flash: (t: string) => void
  /** Prefill the cash-out amount from the wallet's G$ balance when known. */
  defaultAmountG?: number | null
  /** Some of this person's G$ sits in a Jara-managed wallet, which GoodCash cannot reach. */
  heldByJara?: boolean
}

export function GoodCashCard({ userId, wallet, flash, defaultAmountG, heldByJara }: Props) {
  const [error, setError] = useState<string | null>(null)
  if (!goodCashConfigured()) return null

  // GoodCash hands over the one checked transaction; the verified wallet sends it on Celo.
  const send = verifiedSender(wallet, setError)
  const onCashOut = cashOutEvents(flash, setError)

  return (
    <GoodCashProvider publishableKey={PUBLISHABLE_KEY} theme={THEME}>
      <section className="rounded-2xl bg-white p-5">
        <p className="font-bold">Bank with GoodCash</p>
        <p className="mt-1 text-sm leading-relaxed text-ink/60">
          Turn G$ into naira in your own Nigerian bank account, or add G$ by paying naira. One confirmation in your wallet.
        </p>
        {heldByJara && <p className="mt-2 text-xs font-semibold text-ink/55">Cash out uses the G$ in your own wallet ({wallet.slice(0, 6)}…{wallet.slice(-4)}), not G$ held in your Jara jars.</p>}
        <div className="mt-4 grid gap-2">
          <CashOutButton
            label="Cash out G$ to my bank"
            className={primary}
            signer={send}
            wallet={wallet}
            partnerRef={userId}
            defaultAmountG={defaultAmountG && defaultAmountG > 0 ? Math.floor(defaultAmountG) : undefined}
            onEvent={onCashOut}
          />
          <TopUp wallet={wallet} partnerRef={userId} flash={flash} onError={setError} />
        </div>
        {error && <p role="alert" className="mt-3 rounded-xl bg-[#fcf0e7] px-4 py-3 text-sm font-semibold">{error}</p>}
        <p className="mt-3 text-center text-[11px] font-semibold text-ink/45">Powered by GoodCash</p>
      </section>
    </GoodCashProvider>
  )
}

/** Naira in, through widget.js so the already-connected wallet signs and nobody reconnects. */
function TopUp({ wallet, partnerRef, flash, onError }: { wallet: `0x${string}`; partnerRef: string; flash: (t: string) => void; onError: (msg: string | null) => void }) {
  const [busy, setBusy] = useState(false)

  const open = async () => {
    setBusy(true)
    onError(null)
    try {
      const signer = await verifiedWallet(wallet)
      const gc = await loadWidget()
      gc.open({
        publishableKey: PUBLISHABLE_KEY,
        flow: 'topup',
        // Phones block pop-ups, and a separate tab cannot ask this page to sign.
        mode: isMobileBrowser() || isMiniPay() ? 'embed' : 'popup',
        asset: 'g',
        partnerRef,
        theme: THEME,
        wallet,
        signer,
        onEvent: (e: TopUpEvent) => {
          if (e.type === 'topup.delivered') flash('G$ added to your wallet 🎉')
          if (e.type === 'topup.failed') onError('That top-up did not finish. If your naira already left your bank, open Add G$ again to finish it.')
          if (e.type === 'error') onError(e.message)
        },
      })
    } catch (err) {
      onError(err instanceof Error && err.message.startsWith('Switch to your verified') ? err.message : err instanceof Error && /GoodCash/.test(err.message) ? err.message : walletErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <button type="button" className={secondary} disabled={busy} onClick={() => void open()}>
      {busy ? 'Opening…' : 'Add G$ with naira'}
    </button>
  )
}

type GoodCashWidget = { open: (opts: Record<string, unknown>) => void }

function loadWidget(url = 'https://pay.goodcash.xyz/widget.js'): Promise<GoodCashWidget> {
  const w = window as unknown as { GoodCash?: GoodCashWidget }
  if (w.GoodCash?.open) return Promise.resolve(w.GoodCash)
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = url
    s.async = true
    s.onload = () => (w.GoodCash?.open ? resolve(w.GoodCash) : reject(new Error('GoodCash could not load. Try again.')))
    s.onerror = () => reject(new Error('GoodCash could not load. Check your connection and try again.'))
    document.head.appendChild(s)
  })
}
