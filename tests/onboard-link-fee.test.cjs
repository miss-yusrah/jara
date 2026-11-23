/* eslint-disable @typescript-eslint/no-require-imports */
const { test, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { decodeFunctionData, parseAbi } = require('viem')
const directory = mkdtempSync(`${tmpdir()}/jara-onboard-fee-`)
Object.assign(process.env, { DATABASE_URL: `file:${directory}/test.db`, CHAIN_MODE: 'celo', TOPUP_PROVIDER: 'mock', GD_NGN_RATE: '1', TREASURY_PRIVATE_KEY: `0x${'1'.repeat(64)}`, CELO_RPC_URL: 'https://rpc.test.invalid' })
const { db } = require('../src/lib/db.ts')
const chain = require('../src/lib/chain.ts')
const claimers = require('../src/lib/claimers.ts')
const session = require('../src/lib/session.ts')
const users = require('../src/lib/users.ts')
const shared = require('../src/app/api/_shared.ts')
const route = require('../src/app/api/onboard/route.ts')

const root = '0x5555555555555555555555555555555555555555'
const claimer = '0x6666666666666666666666666666666666666666'
const user = { id: 'u-fee', connected: false, rootAddress: root, claimerAddress: claimer }
let linkedTo = null, sponsored = []
session.requireUser = async () => user
users.getUserById = async () => user
claimers.prepareClaimer = async (u) => u
shared.userState = async (u) => ({ user: { id: u.id } })
chain.whitelistedRoot = async (a) => (a.toLowerCase() === claimer ? linkedTo : root)
chain.sponsorWalletCall = async (address, call, operationId) => { sponsored.push({ address, call, operationId }); return true }

const post = (body) => route.POST(new Request('http://localhost/api/onboard', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
beforeEach(() => { linkedTo = null; sponsored = [] })
after(async () => { (await db()).close(); rmSync(directory, { recursive: true, force: true }) })

test('a new wallet gets its link fee covered, for exactly connectAccount(its claim contract)', async () => {
  assert.equal((await post({ action: 'prepare-claimer' })).status, 200)
  assert.equal(sponsored.length, 1)
  const [s] = sponsored
  assert.equal(s.address.toLowerCase(), root)
  assert.equal(s.call.to, chain.GD.identity)
  const decoded = decodeFunctionData({ abi: parseAbi(['function connectAccount(address account)']), data: s.call.data })
  assert.equal(decoded.args[0].toLowerCase(), claimer)
  assert.equal(s.operationId, `link:${root}:${claimer}`)
})

test('an already linked contract needs no fee, and a failed cover never blocks setup', async () => {
  linkedTo = root
  assert.equal((await post({ action: 'prepare-claimer' })).status, 200)
  assert.equal(sponsored.length, 0)
  linkedTo = null
  chain.sponsorWalletCall = async () => { throw new Error('treasury empty') }
  assert.equal((await post({ action: 'prepare-claimer' })).status, 200)
})
