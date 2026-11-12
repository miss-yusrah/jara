/* eslint-disable @typescript-eslint/no-require-imports */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const { parseEther } = require('viem')
const directory = mkdtempSync(`${tmpdir()}/jara-shared-wallet-`)
Object.assign(process.env, { DATABASE_URL: `file:${directory}/test.db`, CHAIN_MODE: 'mock', TOPUP_PROVIDER: 'mock', DEMO_BILLS: 'true', GD_NGN_RATE: '1', PRICE_SPREAD_BPS: '0', TREASURY_PRIVATE_KEY: `0x${'1'.repeat(64)}` })
const { db, run } = require('../src/lib/db.ts')
const users = require('../src/lib/users.ts')
const chain = require('../src/lib/chain.ts')
const { bindWallet, authorizedUser, accountForWallet } = require('../src/lib/wallet-authorization.ts')
const { withAccountLock } = require('../src/lib/account-lock.ts')
const { spendGd } = require('../src/lib/spend.ts')
const { syncJars } = require('../src/lib/jars.ts')
const { checkAutoPay } = require('../src/lib/auto-pay.ts')
const { TransferPendingError } = require('../src/lib/chain-outbox.ts')
const gd = (n) => parseEther(String(n))

async function pair() {
  const a = await users.createUser()
  const b = await users.createUser()
  const root = `0x${createHash('sha256').update(a.id).digest('hex').slice(0, 40)}`
  for (const u of [a, b]) {
    await users.updateUser(u.id, { rootAddress: root, connected: true })
    await run('UPDATE jars SET target_ngn = 0 WHERE user_id = ?', [u.id])
    await run("UPDATE jars SET balance_wei = ? WHERE user_id = ? AND kind = 'ai'", [String(gd(150)), u.id])
  }
  return [await users.getUserById(a.id), await users.getUserById(b.id)]
}

async function approve(accounts) {
  for (const u of accounts) await run('INSERT INTO wallet_sharing(user_id, root_address, created_at) VALUES (?, ?, ?)', [u.id, u.rootAddress.toLowerCase(), Date.now()])
}

test('explicit grants allow both accounts while retaining the default wallet sign-in', async () => {
  const [a, b] = await pair()
  await assert.rejects(bindWallet(a.id, a.rootAddress), /already has a Jara account/)
  await approve([a, b])
  await bindWallet(a.id, a.rootAddress)
  const primary = await accountForWallet(a.rootAddress)
  await bindWallet(b.id, b.rootAddress)
  assert.equal(await accountForWallet(b.rootAddress), primary)
  assert.ok([a.id, b.id].includes(primary))
  const third = await users.createUser()
  await users.updateUser(third.id, { connected: true, rootAddress: a.rootAddress })
  await assert.rejects(bindWallet(third.id, a.rootAddress), /already has a Jara account/)
  // An unapproved duplicate cannot disable the explicitly approved accounts.
  await bindWallet(a.id, a.rootAddress)
  await bindWallet(b.id, b.rootAddress)
})

test('sharing never bypasses the live identity check or grants access to another wallet', async () => {
  const [a, b] = await pair()
  await approve([a, b])
  const original = chain.whitelistedRoot
  process.env.CHAIN_MODE = 'celo'
  chain.whitelistedRoot = async () => a.rootAddress
  try {
    assert.equal((await authorizedUser(a)).id, a.id)
    assert.equal((await authorizedUser(b)).id, b.id)
    chain.whitelistedRoot = async () => null
    await assert.rejects(authorizedUser(b), /wallet link has changed/)
    await users.updateUser(b.id, { rootAddress: `0x${'9'.repeat(40)}` })
    await users.updateUser(a.id, { rootAddress: `0x${'9'.repeat(40)}` })
    await assert.rejects(bindWallet(b.id, `0x${'9'.repeat(40)}`), /already has a Jara account/)
  } finally { chain.whitelistedRoot = original; process.env.CHAIN_MODE = 'mock' }
})

test('different accounts sharing a wallet cannot perform money operations concurrently', async () => {
  const [a, b] = await pair()
  let release, entered
  const ready = new Promise((resolve) => { entered = resolve })
  const held = new Promise((resolve) => { release = resolve })
  const first = withAccountLock(a.id, async () => { entered(); await held })
  await ready
  try {
    await assert.rejects(withAccountLock(b.id, async () => assert.fail('shared wallet lock bypassed')), /Another operation/)
    const unrelated = await users.createUser()
    await withAccountLock(unrelated.id, async () => {})
  } finally { release(); await first }
  await withAccountLock(b.id, async () => {})
})

test('both accounts spend from the current shared balance, and each retry charges only once', async () => {
  const [a, b] = await pair()
  await approve([a, b])
  const originals = { balanceBlock: chain.balanceBlock, gdBalance: chain.gdBalance, gdAllowance: chain.gdAllowance, whitelistedRoot: chain.whitelistedRoot, pullGdFromWallet: chain.pullGdFromWallet }
  let wallet = gd(150), allowance = gd(150), pulls = 0
  chain.balanceBlock = async () => undefined
  chain.whitelistedRoot = async () => a.rootAddress
  chain.gdBalance = async (address) => address.toLowerCase() === a.rootAddress.toLowerCase() ? wallet : 0n
  chain.gdAllowance = async () => allowance
  chain.pullGdFromWallet = async (from, value) => {
    assert.equal(from.toLowerCase(), a.rootAddress.toLowerCase())
    assert.ok(value <= wallet && value <= allowance)
    wallet -= value; allowance -= value; pulls++
    return { hash: `0x${String(pulls).repeat(64)}`, feeWei: 0n }
  }
  process.env.CHAIN_MODE = 'celo'
  try {
    const requestA = { id: `${a.id}:shared-first`, jar: 'ai' }
    const first = await spendGd(a, gd(100), requestA)
    assert.deepEqual(await spendGd(a, gd(100), requestA), first)
    await assert.rejects(spendGd(b, gd(100), { id: `${b.id}:too-much`, jar: 'ai' }), /One wallet must cover/)
    const requestB = { id: `${b.id}:shared-second`, jar: 'ai' }
    const second = await spendGd(b, gd(50), requestB)
    assert.deepEqual(await spendGd(b, gd(50), requestB), second)
    assert.equal(pulls, 2)
    assert.equal(wallet, 0n)
    assert.equal(allowance, 0n)
  } finally { Object.assign(chain, originals); process.env.CHAIN_MODE = 'mock' }
})

test('an uncertain shared-wallet payment blocks spending, budget reconciliation, and new auto-pay on the other account', async () => {
  const [a, b] = await pair()
  await approve([a, b])
  await chain.mockDeposit(b.agentAddress, gd(150))
  await run(`INSERT INTO payments(id, user_id, jar, amount_wei, source, refund_address, created_at)
    VALUES (?, ?, 'ai', ?, 'wallet', ?, ?)`, ['shared-pending', a.id, String(gd(100)), a.rootAddress, Date.now()])
  await assert.rejects(spendGd(b, gd(100), { id: `${b.id}:while-pending`, jar: 'ai' }), TransferPendingError)
  assert.equal(await syncJars(b), 0n)
  await run("UPDATE jars SET auto_pay=1, target_ngn=100, balance_wei=?, details=? WHERE user_id=? AND kind='airtime'", [String(gd(100)), JSON.stringify({ phone: '08031234567', network: 'mtn' }), b.id])
  assert.deepEqual(await checkAutoPay(b), [])
  assert.equal((await run('SELECT COUNT(*) AS n FROM payments WHERE user_id=?', [b.id])).rows[0].n, 0)
  await run("UPDATE payments SET status='failed' WHERE id='shared-pending'")
  await spendGd(b, gd(100), { id: `${b.id}:after-settled`, jar: 'ai' })
  assert.equal(await chain.gdBalance(b.agentAddress), gd(50))
})

after(async () => { (await db()).close(); rmSync(directory, { recursive: true, force: true }) })
