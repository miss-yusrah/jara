/* eslint-disable @typescript-eslint/no-require-imports */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { parseEther } = require('viem')
const directory = mkdtempSync(join(tmpdir(), 'jara-retire-'))
// Real-money mode with no claimer factory, so new accounts get a stored wallet key as legacy accounts did.
Object.assign(process.env, { DATABASE_URL: `file:${join(directory, 'test.db')}`, CHAIN_MODE: 'celo', TOPUP_PROVIDER: 'mock', WALLET_ENCRYPTION_KEY: '3'.repeat(64), ADMIN_KEY: 'admin-test-key' })
for (const key of ['CLAIMER_FACTORY_ADDRESS', 'SPENDING_CONTRACT_ADDRESS', 'WALLET_KEY_PROVIDER']) delete process.env[key]
const { db, run } = require('../src/lib/db.ts')
const users = require('../src/lib/users.ts')
const chain = require('../src/lib/chain.ts')
const wallets = require('../src/lib/wallets.ts')
const { retireAgentKeys } = require('../src/lib/key-retirement.ts')
const adminRoute = require('../src/app/api/admin/treasury/route.ts')

const linked = new Map()
const balances = new Map()
let rpcDown = false
chain.whitelistedRoot = async (address) => { if (rpcDown) throw new Error('rpc down'); return linked.get(address.toLowerCase()) ?? null }
chain.gdBalance = async (address) => { if (rpcDown) throw new Error('rpc down'); return balances.get(address.toLowerCase()) ?? 0n }

after(async () => { (await db()).close(); rmSync(directory, { recursive: true, force: true }) })

const root = (n) => `0x${String(n).repeat(40)}`
const stored = async (id) => String((await run('SELECT agent_key_enc FROM users WHERE id = ?', [id])).rows[0].agent_key_enc)
const decisionFor = (report, id) => report.accounts.find((a) => a.id === id)
async function account(state = {}) {
  const user = await users.createUser({})
  assert.notEqual(user.agentKeyEnc, 'keyless')
  await run('UPDATE users SET root_address = ?, connected = ?, claimer_active = ? WHERE id = ?', [state.root ?? null, state.connected ? 1 : 0, state.upgraded ? 1 : 0, user.id])
  return user
}

test('the report alone never deletes a key', async () => {
  const user = await account()
  const report = await retireAgentKeys()
  assert.equal(report.applied, false)
  assert.equal(decisionFor(report, user.id).retire, true)
  assert.notEqual(await stored(user.id), 'keyless')
  assert.match(await wallets.agentKey(await users.getUserById(user.id)), /^0x[0-9a-f]{64}$/)
})

test('a never-linked, empty wallet loses its key and becomes a keyless account', async () => {
  const user = await account()
  const report = await retireAgentKeys({ apply: true })
  assert.equal(report.applied, true)
  assert.equal(decisionFor(report, user.id).retire, true)
  assert.equal(await stored(user.id), 'keyless')
  await assert.rejects(wallets.agentKey(await users.getUserById(user.id)), /no agent private key/)
  // A second run has nothing left to do for it.
  assert.equal(decisionFor(await retireAgentKeys({ apply: true }), user.id), undefined)
})

test('a connected owner who has not upgraded keeps the key they claim with', async () => {
  const user = await account({ root: root(1), connected: true })
  linked.set(user.agentAddress.toLowerCase(), root(1))
  const decision = decisionFor(await retireAgentKeys({ apply: true }), user.id)
  assert.equal(decision.retire, false)
  assert.match(decision.reason, /has not upgraded/)
  assert.notEqual(await stored(user.id), 'keyless')
})

test('an upgraded owner keeps the old key until the old wallet is unlinked and empty', async () => {
  const user = await account({ root: root(2), connected: true, upgraded: true })
  const wallet = user.agentAddress.toLowerCase()

  linked.set(wallet, root(2))
  assert.match(decisionFor(await retireAgentKeys({ apply: true }), user.id).reason, /still linked/)
  linked.delete(wallet)

  balances.set(wallet, parseEther('12.5'))
  assert.match(decisionFor(await retireAgentKeys({ apply: true }), user.id).reason, /still holds G\$ 12\.5/)
  assert.notEqual(await stored(user.id), 'keyless')
  balances.delete(wallet)

  assert.equal(decisionFor(await retireAgentKeys({ apply: true }), user.id).retire, true)
  assert.equal(await stored(user.id), 'keyless')
})

test('anything in flight for the wallet or the account keeps the key', async () => {
  const sending = await account({ root: root(5), connected: true, upgraded: true })
  await run("INSERT INTO chain_transactions (id, sender, intent, raw, hash, status, created_at) VALUES ('claim:old', ?, '{}', '0x', '0xaa', 'pending', 1)", [sending.agentAddress.toLowerCase()])
  const receiving = await account({ root: root(6), connected: true, upgraded: true })
  await run("INSERT INTO chain_transactions (id, sender, intent, raw, hash, status, created_at) VALUES ('reward:old', '0xtreasury', ?, '0x', '0xbb', 'pending', 1)", [JSON.stringify({ transfer: { to: receiving.agentAddress } })])
  const paying = await account({ root: root(7), connected: true, upgraded: true })
  await run("INSERT INTO payments (id, user_id, jar, amount_wei, source, refund_address, status, created_at) VALUES ('pay:old', ?, 'bills', '1', 'jar', ?, 'refunding', 1)", [paying.id, paying.agentAddress])

  const report = await retireAgentKeys({ apply: true })
  assert.match(decisionFor(report, sending.id).reason, /transaction involving this wallet/)
  assert.match(decisionFor(report, receiving.id).reason, /transaction involving this wallet/)
  assert.match(decisionFor(report, paying.id).reason, /payment or refund/)
  for (const user of [sending, receiving, paying]) assert.notEqual(await stored(user.id), 'keyless')

  await run("UPDATE chain_transactions SET status = 'confirmed' WHERE id IN ('claim:old', 'reward:old')")
  await run("UPDATE payments SET status = 'refunded' WHERE id = 'pay:old'")
  const settled = await retireAgentKeys({ apply: true })
  for (const user of [sending, receiving, paying]) assert.equal(decisionFor(settled, user.id).retire, true)
})

test('an unreadable chain deletes nothing', async () => {
  const user = await account()
  rpcDown = true
  try {
    const decision = decisionFor(await retireAgentKeys({ apply: true }), user.id)
    assert.equal(decision.retire, false)
    assert.match(decision.reason, /Could not read/)
    assert.notEqual(await stored(user.id), 'keyless')
  } finally { rpcDown = false }
})

test('a key that starts being used between the report and the delete is kept', async () => {
  const user = await account()
  const wallet = user.agentAddress.toLowerCase()
  const original = chain.gdBalance
  let reads = 0
  // Empty when first looked at, funded by the time the account lock is held.
  chain.gdBalance = async (address) => (address.toLowerCase() === wallet && ++reads > 1 ? parseEther('40') : original(address))
  try {
    const decision = decisionFor(await retireAgentKeys({ apply: true }), user.id)
    assert.equal(decision.retire, false)
    assert.match(decision.reason, /still holds/)
    assert.notEqual(await stored(user.id), 'keyless')
  } finally { chain.gdBalance = original; balances.set(wallet, parseEther('40')) }
})

test('only the admin can read the report or delete keys, and deleting takes an explicit request', async () => {
  const user = await account()
  const url = 'http://localhost/api/admin/treasury?custody=retire'
  const admin = { authorization: 'Bearer admin-test-key', 'content-type': 'application/json' }
  assert.equal((await adminRoute.GET(new Request(url))).status, 401)
  assert.equal((await adminRoute.POST(new Request(url, { method: 'POST', body: JSON.stringify({ retireKeys: true }) }))).status, 401)

  const report = await (await adminRoute.GET(new Request(url, { headers: admin }))).json()
  assert.equal(report.applied, false)
  assert.equal(decisionFor(report, user.id).retire, true)
  assert.notEqual(await stored(user.id), 'keyless')

  const applied = await (await adminRoute.POST(new Request(url, { method: 'POST', headers: admin, body: JSON.stringify({ retireKeys: true }) }))).json()
  assert.equal(applied.applied, true)
  assert.equal(await stored(user.id), 'keyless')
  // What is left is exactly what the report said to keep.
  assert.equal(applied.custody.wallets, applied.kept)
})
