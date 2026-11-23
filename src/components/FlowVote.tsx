'use client'

// Vote for Jara in the GoodBuilders Flow Council without leaving the app.
// Adapted from github.com/Calebux/flowstate-vote-kit: the kit's wagmi hook is
// replaced with Jara's own wallet layer (Web3Auth, MiniPay or an external
// wallet), and every write is locked to the person's verified GoodDollar wallet.
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPublicClient, createWalletClient, custom, encodeFunctionData, formatEther, http, type Address, type EIP1193Provider, type Hash } from 'viem'
import { celo } from 'viem/chains'
import { getWalletProvider, prewarmWallet } from '@/lib/web3auth'
import { walletErrorMessage } from '@/lib/wallet-connect'
import { RenewVerificationButton } from './RenewVerification'
import {
  FLOW_ABI, FLOW_CHAIN, FLOW_COUNCIL, FLOW_URL, PROJECT_NAME,
  buildFlowVote, flowAllocation, flowClaimMessage, flowSnapshotKey, matchesFlowVoteTransaction, readFlowSnapshot,
  type FlowMetadata, type FlowSnapshot, type FlowVote as Ballot,
} from '@/lib/flowstate'

type Pending = { hash: Hash; amount: string }
// covered: Jara tops the wallet up for this vote just before it is sent.
type Review = { snapshotKey: string; amount: string; votes: Ballot[]; fee: string; covered: boolean }

/** GoodDollar community members get 10 votes; give Jara all of them by default. */
const DEFAULT_VOTES = 10n
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`
const pendingKey = (address: Address) => `jara:flow-vote:${FLOW_CHAIN}:${FLOW_COUNCIL}:${address.toLowerCase()}`
const publicClient = createPublicClient({ chain: celo, transport: http() })

function insufficientFunds(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { message?: unknown; shortMessage?: unknown; name?: unknown; cause?: unknown }
  const text = [e.message, e.shortMessage, e.name].filter((v) => typeof v === 'string').join(' ')
  return /insufficient funds|insufficient balance|exceeds balance|gas required exceeds|InsufficientFunds/i.test(text) || insufficientFunds(e.cause)
}
const cancelled = (err: unknown) => {
  const e = err as { code?: unknown; message?: unknown } | null
  return e?.code === 4001 || (typeof e?.message === 'string' && /user rejected|rejected the request|user denied|user cancel/i.test(e.message))
}

async function json<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null)
  if (!data || typeof data !== 'object') throw new Error('Voting service returned an incomplete response. Please retry.')
  if (!response.ok) throw new Error((data as { error?: string }).error ?? 'Voting service is unavailable. Please retry.')
  return data as T
}

/** Mounted with key=rootAddress so nothing carries over to another account. */
export function FlowVote({ rootAddress }: { rootAddress: string }) {
  const address = rootAddress.toLowerCase() as Address
  const [metadata, setMetadata] = useState<FlowMetadata | null>(null)
  const [snapshot, setSnapshot] = useState<FlowSnapshot | null>(null)
  const [amount, setAmount] = useState('')
  const [review, setReview] = useState<Review | null>(null)
  const [pending, setPending] = useState<Pending | null>(() => {
    // A saved hash means a vote may already be in flight: never offer a resend.
    try {
      const saved = typeof window === 'undefined' ? null : JSON.parse(localStorage.getItem(pendingKey(address)) ?? 'null')
      return saved && /^0x[0-9a-f]{64}$/i.test(saved.hash) && /^\d{1,29}$/.test(saved.amount) ? saved : null
    } catch {
      return null
    }
  })
  const [confirmed, setConfirmed] = useState<Hash | null>(null)
  const [busy, setBusy] = useState('Checking your voting status…')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(true)
  const running = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const readSnapshot = useCallback(() => readFlowSnapshot(publicClient, address), [address])

  const refresh = useCallback(async () => {
    const [meta, state] = await Promise.all([fetch('/api/flowstate', { cache: 'no-store' }).then((r) => json<FlowMetadata>(r)), readSnapshot()])
    if (!mounted.current) return state
    setMetadata(meta)
    setSnapshot(state)
    setReview(null)
    const allocation = flowAllocation(state)
    // New voters start at the full 10 community votes (or whatever is left beside
    // their other allocations); people who already voted see their current choice.
    const start = allocation.maximum < DEFAULT_VOTES ? allocation.maximum : DEFAULT_VOTES
    setAmount(allocation.current > 0n ? String(allocation.current) : start > 0n ? String(start) : '')
    return state
  }, [readSnapshot])

  useEffect(() => {
    let alive = true
    refresh()
      .catch(() => alive && setError('Couldn’t load your voting status. Please retry.'))
      .finally(() => alive && setBusy(''))
    return () => {
      alive = false
    }
  }, [refresh])

  async function run(label: string, action: () => Promise<void>) {
    if (running.current) return
    running.current = true
    setBusy(label)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (err) {
      if (!mounted.current) return
      if (cancelled(err)) setNotice('Cancelled. No new vote was submitted.')
      else if (insufficientFunds(err)) setError(`Your wallet ${short(address)} is still short of CELO for the network fee. Wait a moment and tap Confirm vote again.`)
      else setError(err instanceof Error && err.message.length < 260 ? walletErrorMessage(err) : 'Couldn’t complete this step. Refresh your voting status and try again.')
    } finally {
      running.current = false
      if (mounted.current) setBusy('')
    }
  }

  /** The person's wallet, only if it is their verified Jara wallet, on Celo. */
  async function signer() {
    const provider = await getWalletProvider()
    const wallet = createWalletClient({ chain: celo, transport: custom(provider) })
    const [account] = await wallet.requestAddresses()
    if (!account || account.toLowerCase() !== address) throw new Error(`Switch to your verified wallet ${short(address)} to vote. It’s the one connected to your Jara account.`)
    await wallet.switchChain({ id: celo.id }).catch(() => wallet.addChain({ chain: celo }))
    return { wallet, provider }
  }
  /** Re-check after any await: the wallet must not have changed accounts. */
  async function assertSame(provider: EIP1193Provider) {
    if (!mounted.current) throw new Error('Voting was closed. Reopen it to continue.')
    const [account] = (await provider.request({ method: 'eth_accounts' })) as string[]
    if (account?.toLowerCase() !== address) throw new Error(`Your wallet changed. Switch back to ${short(address)} and try again.`)
  }

  /** Ask Jara to top up this wallet for the exact vote, then wait until the
   * CELO is visible to the public RPC the wallet will check against. */
  async function coverFee(votes: string) {
    const result = await fetch('/api/flowstate/gas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-flow-vote': '1' },
      body: JSON.stringify({ amount: votes }),
      signal: AbortSignal.timeout(90_000),
    }).then((r) => json<{ sponsored: boolean }>(r))
    if (!result.sponsored) return
    const data = encodeFunctionData({ abi: FLOW_ABI, functionName: 'vote', args: [buildFlowVote(await readSnapshot(), votes)] })
    for (let i = 0; i < 10; i++) {
      const [gas, gasPrice, balance] = await Promise.all([
        publicClient.estimateGas({ account: address, to: FLOW_COUNCIL, data }),
        publicClient.getGasPrice(),
        publicClient.getBalance({ address }),
      ])
      if (balance >= gas * gasPrice * 2n) return
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  }

  const claim = () =>
    run('Opening your wallet…', async () => {
      const { wallet, provider } = await signer()
      const state = await refresh()
      if (!state.verified) throw new Error('Renew your GoodDollar verification first.')
      if (state.votingPower > 0n) return setNotice('Your voting rights are already active.')
      setBusy('Sign to claim your voting rights (free)…')
      const issuedAt = Date.now()
      const signature = await wallet.signMessage({ account: address, message: flowClaimMessage(address, issuedAt) })
      await assertSame(provider)
      setBusy('Activating your voting rights…')
      await fetch('/api/flowstate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-flow-vote': '1' },
        body: JSON.stringify({ address, issuedAt, signature }),
        signal: AbortSignal.timeout(25_000),
      }).then((r) => json(r))
      const updated = await refresh()
      setNotice(updated.votingPower > 0n ? 'Voting rights active. Choose how many votes to give Jara.' : 'Registration received. Refresh in a moment to load your votes.')
    })

  const prepare = () =>
    run('Preparing your ballot…', async () => {
      if (!metadata) throw new Error('Refresh voting details first.')
      const state = await readSnapshot()
      setSnapshot(state)
      const votes = buildFlowVote(state, amount)
      const data = encodeFunctionData({ abi: FLOW_ABI, functionName: 'vote', args: [votes] })
      await publicClient.simulateContract({ account: address, address: FLOW_COUNCIL, abi: FLOW_ABI, functionName: 'vote', args: [votes] })
      const [gas, gasPrice, balance] = await Promise.all([
        publicClient.estimateGas({ account: address, to: FLOW_COUNCIL, data }),
        publicClient.getGasPrice(),
        publicClient.getBalance({ address }),
      ])
      const fee = (gas * gasPrice * 12n) / 10n
      setReview({ snapshotKey: flowSnapshotKey(state), amount: votes[0].amount.toString(), votes, fee: formatEther(fee), covered: balance < gas * gasPrice * 2n })
    })

  async function finish(record: Pending, wait: boolean) {
    let receipt
    try {
      receipt = wait
        ? await publicClient.waitForTransactionReceipt({ hash: record.hash, confirmations: 1, timeout: 45_000 })
        : await publicClient.getTransactionReceipt({ hash: record.hash })
    } catch {
      if (mounted.current) setNotice('Your vote was sent, but confirmation is still pending. Check its status below; don’t vote again.')
      return
    }
    if (receipt.status === 'success') {
      // A replacement may be a cancellation: a successful receipt alone is not
      // evidence that this ballot was cast.
      let tx
      try {
        tx = await publicClient.getTransaction({ hash: receipt.transactionHash })
      } catch {
        if (mounted.current) setNotice('The receipt arrived, but the vote could not be verified yet. Check its status again.')
        return
      }
      if (!matchesFlowVoteTransaction(address, record.amount, tx)) {
        try { localStorage.removeItem(pendingKey(address)) } catch { /* optional */ }
        if (mounted.current) { setPending(null); setReview(null) }
        throw new Error('This transaction did not cast the reviewed vote. Refresh your ballot before trying again.')
      }
    }
    try { localStorage.removeItem(pendingKey(address)) } catch { /* optional */ }
    if (!mounted.current) return
    setPending(null)
    setReview(null)
    if (receipt.status !== 'success') throw new Error('The vote transaction reverted. Refresh your ballot before retrying. A network fee may have been charged.')
    setConfirmed(receipt.transactionHash)
    setNotice('Your vote is confirmed on Celo. Thank you for supporting Jara! 💚')
    try { await refresh() } catch { setNotice('Your vote is confirmed on Celo. The latest ballot could not be refreshed yet.') }
  }

  const submit = () =>
    run('Opening your wallet…', async () => {
      if (!review || pending) return
      const { wallet, provider } = await signer()
      const state = await readSnapshot()
      if (flowSnapshotKey(state) !== review.snapshotKey) {
        setSnapshot(state)
        setReview(null)
        throw new Error('Your ballot or voting rights changed. Review your vote again before confirming.')
      }
      const votes = buildFlowVote(state, review.amount)
      await publicClient.simulateContract({ account: address, address: FLOW_COUNCIL, abi: FLOW_ABI, functionName: 'vote', args: [votes] })
      setBusy('Jara is covering your network fee…')
      await coverFee(review.amount)
      await assertSame(provider)
      setBusy('Confirm your vote in your wallet…')
      const hash = await wallet.writeContract({ chain: celo, account: address, address: FLOW_COUNCIL, abi: FLOW_ABI, functionName: 'vote', args: [votes] })
      const record = { hash, amount: review.amount }
      try { localStorage.setItem(pendingKey(address), JSON.stringify(record)) } catch { /* pending state still shown */ }
      if (!mounted.current) return
      setPending(record)
      setReview(null)
      setBusy('Waiting for confirmation…')
      await finish(record, true)
    })

  const s = snapshot
  const allocation = s ? flowAllocation(s) : null
  const tx = confirmed ?? pending?.hash

  return (
    <section className="app-card mb-6 p-6" aria-label={`Vote for ${PROJECT_NAME} on Flowstate`}>
      <p className="text-xs font-bold tracking-wider text-forest uppercase">GoodBuilders · Flowstate</p>
      <h3 className="mt-1 text-lg font-bold">Vote for Jara</h3>
      <p className="mt-2 text-sm leading-relaxed text-ink/65">
        Verified GoodDollar members can back Jara in the GoodBuilders council. It’s free: claiming your votes is a signature, and Jara covers the network fee for your vote.
        {allocation && allocation.current > 0n && ` You’re giving Jara ${allocation.current} vote${allocation.current === 1n ? '' : 's'} right now.`}
      </p>

      {busy && <p role="status" className="mt-3 text-sm text-ink/60">{busy}</p>}
      {error && <p role="alert" className="mt-3 text-sm text-mandarin">{error}</p>}
      {notice && <p role="status" className="mt-3 text-sm text-forest">{notice}</p>}

      <div className="mt-4 grid gap-3">
        {!s ? (
          error && <button className="app-button-secondary justify-self-start" disabled={!!busy} onClick={() => run('Refreshing…', async () => void (await refresh()))}>Try again</button>
        ) : !s.verified ? (
          <>
            <p className="text-sm text-ink/70">
              Your GoodDollar verification for {short(address)} needs renewing before you can vote. Renew it with this same wallet, not a new one.
            </p>
            <RenewVerificationButton rootAddress={address} />
            <button className="app-button-secondary justify-self-start" disabled={!!busy} onClick={() => run('Refreshing…', async () => void (await refresh()))}>I’ve renewed · check again</button>
          </>
        ) : !s.recipientActive ? (
          <p className="text-sm text-ink/70">Jara isn’t accepting votes in this council right now.</p>
        ) : s.votingPower === 0n ? (
          <button className="app-button justify-self-start bg-forest text-cream disabled:opacity-60" disabled={!!busy} onPointerEnter={prewarmWallet} onPointerDown={prewarmWallet} onClick={claim}>
            Claim my voting rights (free)
          </button>
        ) : review ? (
          <>
            <p className="text-sm text-ink/75">
              Change Jara’s votes from {String(allocation?.current ?? 0n)} to <b>{review.amount}</b>. Your votes for other projects stay as they are.
            </p>
            <p className="text-xs text-ink/55">
              {review.covered ? 'Network fee: covered by Jara 💚' : `Network fee: about ${Number(review.fee).toFixed(5)} CELO`}
            </p>
            <div className="flex flex-wrap gap-3">
              <button className="app-button bg-forest text-cream disabled:opacity-60" disabled={!!busy} onPointerEnter={prewarmWallet} onClick={submit}>Confirm vote</button>
              <button className="app-button-secondary" disabled={!!busy} onClick={() => setReview(null)}>Back</button>
            </div>
          </>
        ) : !pending ? (
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm font-semibold">
              <span>Votes for Jara <span className="font-normal text-ink/55">(up to {String(allocation?.maximum ?? 0n)})</span></span>
              <input
                inputMode="numeric"
                value={amount}
                onChange={(e) => { setAmount(e.target.value.replace(/\D/g, '')); setReview(null); setConfirmed(null) }}
                className="w-32 rounded-xl border border-ink/10 bg-white px-3 py-2 font-normal"
              />
            </label>
            <button className="app-button bg-forest text-cream disabled:opacity-60" disabled={!!busy || !amount} onClick={prepare}>Review vote</button>
            <p className="w-full text-xs text-ink/55">Set to your full {String(allocation?.maximum ?? DEFAULT_VOTES)} votes. You can lower it before you confirm.</p>
          </div>
        ) : null}

        {tx && (
          <p className="flex flex-wrap items-center gap-3 text-sm">
            <a href={`https://celoscan.io/tx/${tx}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-forest underline">View transaction ↗</a>
            {pending && <button className="font-semibold text-forest underline disabled:opacity-50" disabled={!!busy} onClick={() => run('Checking your vote…', () => finish(pending, false))}>Check submitted vote</button>}
          </p>
        )}
      </div>

      <p className="mt-4 text-xs text-ink/50">
        Using a smart-contract wallet? Vote directly on <a href={FLOW_URL} target="_blank" rel="noopener noreferrer" className="underline">Flowstate</a>.
      </p>
    </section>
  )
}
