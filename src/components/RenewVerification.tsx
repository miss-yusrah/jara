'use client'

import { useEffect, useState } from 'react'
import type { EIP1193Provider } from 'viem'
import { connectedWallet, getWalletProvider, isInAppBrowser, isMobileBrowser, prewarmWallet } from '@/lib/web3auth'
import { faceVerificationLink, requestAddress, walletErrorMessage } from '@/lib/wallet-connect'

// Phones sign in by leaving Jara and coming back; this remembers a renewal in progress.
const PENDING_KEY = 'jara:renew-fv'
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/**
 * Renews GoodDollar face verification for the person's existing verified wallet,
 * from inside Jara. Sending people to GoodWallet instead lets them sign in there
 * a different way, which makes a brand-new wallet whose face check is then
 * rejected as a duplicate of the one they already have.
 */
export function RenewVerificationButton({ rootAddress, label = 'Renew GoodDollar verification', className }: { rootAddress: string; label?: string; className?: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inApp, setInApp] = useState(false)

  const go = async (provider: EIP1193Provider) => {
    const account = await requestAddress(provider)
    if (account.toLowerCase() !== rootAddress.toLowerCase())
      throw new Error(`This wallet is ${short(account)}. Sign in the same way you first did, so it opens your verified wallet ${short(rootAddress)}.`)
    const link = await faceVerificationLink(provider, account, `${window.location.origin}/app?fv=renew`)
    // Clear before leaving, so coming back from the face check doesn't start it again.
    try { window.sessionStorage.removeItem(PENDING_KEY) } catch { /* private browsing */ }
    window.location.href = link
  }
  const fail = (err: unknown) => {
    try { window.sessionStorage.removeItem(PENDING_KEY) } catch { /* private browsing */ }
    setError(walletErrorMessage(err))
    setBusy(false)
  }

  // Back from a phone login: carry on with the renewal they started.
  useEffect(() => {
    let pending = false
    try { pending = window.sessionStorage.getItem(PENDING_KEY) === rootAddress.toLowerCase() } catch { /* private browsing */ }
    queueMicrotask(() => setInApp(isMobileBrowser() && isInAppBrowser()))
    if (!pending) return
    // Claim it now: the button shows on more than one card, and only one may continue.
    try { window.sessionStorage.removeItem(PENDING_KEY) } catch { /* private browsing */ }
    queueMicrotask(() => setBusy(true))
    void connectedWallet().then(
      (provider) => {
        if (provider) return go(provider).catch(fail)
        setBusy(false)
      },
      fail,
    )
    // Runs once per mount; go/fail only read rootAddress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootAddress])

  const renew = async () => {
    setBusy(true); setError(null)
    try {
      try { window.sessionStorage.setItem(PENDING_KEY, rootAddress.toLowerCase()) } catch { /* private browsing */ }
      await go(await getWalletProvider())
    } catch (err) {
      fail(err)
    }
  }

  return (
    <span className="grid gap-1">
      <button type="button" onPointerEnter={prewarmWallet} onPointerDown={prewarmWallet} onClick={renew} disabled={busy}
        className={className ?? 'app-button justify-self-start bg-forest text-cream hover:bg-forest-soft disabled:opacity-60'}>
        {busy ? 'Opening the face check…' : label}
      </button>
      {inApp && (
        <span className="text-sm text-mandarin">
          The face check needs your camera, and this in-app browser may block it. Tap ⋮ or the share icon and choose “Open in Chrome” or “Open in Safari”, then renew there.
        </span>
      )}
      {error && <span role="alert" className="text-sm text-mandarin">{error}</span>}
    </span>
  )
}
