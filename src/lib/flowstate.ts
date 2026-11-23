// Flowstate / GoodBuilders council voting for Jara. Built on
// Jara's own wallet layer (no wagmi).
import { decodeFunctionData, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'

// Jara's recipient in the council, lowercase, as listed by
// https://flowstate.network/api/flow-council/recipients?chainId=42220&councilId=<FLOW_COUNCIL>
// Pinned here: a vote destination is never taken from a URL or request body.
export const PROJECT_RECIPIENT = '0xefc388ecc86793cea56bd6708d7d77bb6388c58c' as Address
// Jara's name as Flowstate lists it. The API route refuses to serve if the
// pinned recipient's listed name stops matching, guarding a wrong address.
export const PROJECT_NAME = 'Jara'
// GoodBuilders S5 council on Celo mainnet.
export const FLOW_COUNCIL = '0x889e0aadaa3f8b28a794ef70da147827c620a590' as Address

export const IDENTITY_CONTRACT = '0xC361A6E67822a0EDc17D899227dd9FC50BD62F42' as Address
export const IDENTITY_ABI = parseAbi(['function getWhitelistedRoot(address account) view returns (address)'])
export const normalizeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')
export const FLOW_CHAIN = 42220
export const FLOW_URL = `https://flowstate.network/flow-councils/${FLOW_CHAIN}/${FLOW_COUNCIL}`
export const FLOW_QUERY = `chainId=${FLOW_CHAIN}&councilId=${FLOW_COUNCIL}`

// Minimal Flow Council ABI from flow-state-coop/platform/src/lib/abi/flowCouncil.ts.
export const FLOW_ABI = parseAbi([
  'function getVoter(address) view returns ((address account, uint96 votingPower, (uint160 recipientId, uint96 amount)[] votes) voter)',
  'function getVotes(address) view returns ((address recipient, uint96 amount)[])',
  'function getRecipient(address) view returns ((address account, uint96 votes) recipient)',
  'function maxVotingSpread() view returns (uint8)',
  'function vote((address recipient, uint96 amount)[] votes)',
])
export type FlowVote = { recipient: Address; amount: bigint }
export type FlowMetadata = { communityVotes: number; recipients: { address: Address; name: string | null }[] }
export type FlowSnapshot = { votingPower: bigint; votes: readonly FlowVote[]; maxSpread: number; verified: boolean; recipientActive: boolean }

/** Council and identity state for one wallet. Used by the card and by the
 * server before it sponsors a vote, so both apply the same rules. */
export async function readFlowSnapshot(client: Pick<PublicClient, 'readContract'>, wallet: Address): Promise<FlowSnapshot> {
  const address = wallet.toLowerCase() as Address
  const [voter, votes, maxSpread, root, recipient] = await Promise.all([
    client.readContract({ address: FLOW_COUNCIL, abi: FLOW_ABI, functionName: 'getVoter', args: [address] }),
    client.readContract({ address: FLOW_COUNCIL, abi: FLOW_ABI, functionName: 'getVotes', args: [address] }),
    client.readContract({ address: FLOW_COUNCIL, abi: FLOW_ABI, functionName: 'maxVotingSpread' }),
    client.readContract({ address: IDENTITY_CONTRACT, abi: IDENTITY_ABI, functionName: 'getWhitelistedRoot', args: [address] }),
    client.readContract({ address: FLOW_COUNCIL, abi: FLOW_ABI, functionName: 'getRecipient', args: [PROJECT_RECIPIENT] }),
  ])
  return {
    votingPower: voter.votingPower,
    votes,
    maxSpread,
    // The wallet itself must be the verified root: voting rights belong to it.
    verified: root !== zeroAddress && root.toLowerCase() === address,
    recipientActive: recipient.account.toLowerCase() === PROJECT_RECIPIENT,
  }
}

/** Flowstate's exact claim message (lib/claimMessage.ts). It claims council
 * membership only; casting a ballot is a separate transaction. */
export function flowClaimMessage(address: Address, issuedAt: number) {
  const timestamp = new Date(Math.floor(issuedAt / 1000) * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
  return ['Claim voting rights in this Flow Council.', '', `Council: ${FLOW_COUNCIL}`, `Chain: ${FLOW_CHAIN}`, `Wallet: ${address.toLowerCase()}`, `Issued at: ${timestamp}`].join('\n')
}

export function flowAllocation(snapshot: FlowSnapshot) {
  const current = snapshot.votes.find((v) => v.recipient.toLowerCase() === PROJECT_RECIPIENT)?.amount ?? 0n
  const other = snapshot.votes.filter((v) => v.recipient.toLowerCase() !== PROJECT_RECIPIENT && v.recipient !== zeroAddress)
  const otherTotal = other.reduce((sum, vote) => sum + vote.amount, 0n)
  const maximum = snapshot.votingPower > otherTotal ? snapshot.votingPower - otherTotal : 0n
  return { current, other, otherTotal, maximum }
}

export function buildFlowVote(snapshot: FlowSnapshot, input: string): FlowVote[] {
  if (!snapshot.verified) throw new Error('Renew your GoodDollar verification before voting.')
  if (!snapshot.recipientActive) throw new Error(`${PROJECT_NAME} is not accepting votes in this council right now.`)
  if (snapshot.votingPower <= 0n) throw new Error('Claim your voting rights first.')
  if (!/^\d{1,29}$/.test(input)) throw new Error('Enter a whole number of votes.')
  const amount = BigInt(input)
  const { current, other, maximum } = flowAllocation(snapshot)
  if (amount <= 0n || amount > maximum) throw new Error(`Choose between 1 and ${maximum} votes. Your other allocations stay in place.`)
  if (amount === current) throw new Error(`Your ballot already gives ${PROJECT_NAME} this many votes.`)
  if (snapshot.maxSpread > 0 && other.filter((v) => v.amount > 0n).length + 1 > snapshot.maxSpread)
    throw new Error('Your ballot already uses the council’s project limit. Edit your other allocations on Flowstate first.')
  // vote() changes only the recipients supplied. Sending just our pinned
  // recipient preserves every other allocation, even ones the indexer misses.
  return [{ recipient: PROJECT_RECIPIENT, amount }]
}

export function flowSnapshotKey(snapshot: FlowSnapshot) {
  return [
    snapshot.votingPower, snapshot.maxSpread, snapshot.verified, snapshot.recipientActive,
    ...snapshot.votes.map((v) => `${v.recipient.toLowerCase()}:${v.amount}`).sort(),
  ].join('|')
}

/** True only if the transaction is exactly the reviewed single-recipient ballot. */
export function matchesFlowVoteTransaction(address: Address, amount: string, tx: { from: Address; to: Address | null; input: Hex; value: bigint }) {
  try {
    const decoded = decodeFunctionData({ abi: FLOW_ABI, data: tx.input })
    const entries = decoded.functionName === 'vote' ? decoded.args[0] : []
    return (
      tx.from.toLowerCase() === address.toLowerCase() &&
      tx.to?.toLowerCase() === FLOW_COUNCIL &&
      tx.value === 0n &&
      entries.length === 1 &&
      entries[0].recipient.toLowerCase() === PROJECT_RECIPIENT &&
      entries[0].amount.toString() === amount
    )
  } catch {
    return false
  }
}
