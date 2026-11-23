'use client'

import { useState } from 'react'
import { getWalletProvider, prewarmWallet } from '@/lib/web3auth'
import { faceVerificationLink, requestAddress, walletErrorMessage } from '@/lib/wallet-connect'

/**
 * Renews GoodDollar face verification for the person's existing verified wallet,
 * from inside Jara. Sending people to GoodWallet instead lets them sign in there
 * a different way, which makes a brand-new wallet whose face check is then
 * rejected as a duplicate of the one they already have.
 */
export function RenewVerificationButton({ rootAddress, label = 'Renew GoodDollar verification', className }: { rootAddress: string; label?: string; className?: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const renew = async () => {
    setBusy(true); setError(null)
    try {
      const provider = await getWalletProvider()
      const account = await requestAddress(provider)
      if (account.toLowerCase() !== rootAddress.toLowerCase())
        throw new Error(`This wallet is ${account.slice(0, 6)}…${account.slice(-4)}. Sign in the same way you first did, so it opens your verified wallet ${rootAddress.slice(0, 6)}…${rootAddress.slice(-4)}.`)
      window.location.href = await faceVerificationLink(provider, account, `${window.location.origin}/app?fv=renew`)
    } catch (err) {
      setError(walletErrorMessage(err))
      setBusy(false)
    }
  }
  return (
    <span className="grid gap-1">
      <button type="button" onPointerEnter={prewarmWallet} onPointerDown={prewarmWallet} onClick={renew} disabled={busy}
        className={className ?? 'app-button justify-self-start bg-forest text-cream hover:bg-forest-soft disabled:opacity-60'}>
        {busy ? 'Sign the message in your wallet…' : label}
      </button>
      {error && <span role="alert" className="text-sm text-mandarin">{error}</span>}
    </span>
  )
}
