/* eslint-disable @typescript-eslint/no-require-imports */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { parseEther, encodeAbiParameters, encodeEventTopics, decodeFunctionData, verifyMessage, zeroAddress } = require('viem')
const { privateKeyToAccount } = require('viem/accounts')
const directory = mkdtempSync(`${tmpdir()}/jara-keyless-`)
const factory = '0x1111111111111111111111111111111111111111'
const contract = '0x2222222222222222222222222222222222222222'
const policy = '0x3333333333333333333333333333333333333333'
const owner = privateKeyToAccount(`0x${'4'.repeat(64)}`)
Object.assign(process.env, { DATABASE_URL: `file:${directory}/test.db`, CHAIN_MODE: 'celo', TOPUP_PROVIDER: 'mock', GD_NGN_RATE: '1', TREASURY_PRIVATE_KEY: `0x${'1'.repeat(64)}`, CLAIMER_FACTORY_ADDRESS: factory, SPENDING_CONTRACT_ADDRESS: policy, CELO_RPC_URL: 'https://rpc.test.invalid' })
const { db, run } = require('../src/lib/db.ts')
const users = require('../src/lib/users.ts')
const chain = require('../src/lib/chain.ts')
const wallets = require('../src/lib/wallets.ts')
const outbox = require('../src/lib/chain-outbox.ts')
const claimers = require('../src/lib/claimers.ts')
const { spendingPolicyAbi } = require('../src/lib/spending-policy.ts')
const { walletClaimerMessage } = require('../src/lib/wallet-login.ts')
const { authorizedUser } = require('../src/lib/wallet-authorization.ts')
const spend = require('../src/lib/spend.ts')
let roots = new Map(), deployed = false, allowance = 0n, available = parseEther('1000'), token = chain.GD.token
let calls = [], submitted = new Set(), entitlement = parseEther('100'), agentBalance = parseEther('2000')
chain.whitelistedRoot = async (address) => roots.get(address.toLowerCase()) ?? null
chain.verifyWalletSignature = verifyMessageShim
async function verifyMessageShim(address, message, signature) { return verifyMessage({ address, message, signature }) }
chain.entitlement = async () => entitlement
chain.balanceBlock = async () => 1n
chain.gdBalance = async (address) => address.toLowerCase() === owner.address.toLowerCase() ? parseEther('5000') : agentBalance
outbox.hasSubmittedTransaction = async (id) => submitted.has(id)
outbox.durableTransaction = async (id, key, input) => {
  calls.push({ id, key, input }); submitted.add(id)
  if (input.to === factory) deployed = true
  return { hash: `0x${'a'.repeat(64)}`, feeWei: 10n }
}
const originalFetch = global.fetch
const abi = [...claimers.claimerAbi, ...claimers.claimerFactoryAbi, ...spendingPolicyAbi, { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] }]
global.fetch = async (_url, init) => {
  const req = JSON.parse(init.body)
  let result
  if (req.method === 'eth_getCode') result = deployed ? '0x6000' : '0x'
  else if (req.method === 'eth_call') {
    const decoded = decodeFunctionData({ abi, data: req.params[0].data })
    const values = { gd: token, ubi: chain.GD.ubi, owner: owner.address, claimerOf: contract, operator: chain.treasuryAddress(), recipient: chain.treasuryAddress(), allowance, available }
    if (!(decoded.functionName in values)) throw new Error(`Unexpected call ${decoded.functionName}`)
    const value = values[decoded.functionName]
    result = encodeAbiParameters([{ type: typeof value === 'bigint' ? 'uint256' : 'address' }], [value])
  } else if (req.method === 'eth_getTransactionReceipt') {
    const log = { address: contract, topics: encodeEventTopics({ abi: claimers.claimerAbi, eventName: 'Claimed', args: { owner: owner.address } }), data: encodeAbiParameters([{ type: 'uint256' }], [parseEther('100')]), blockNumber: '0x1', transactionHash: req.params[0], transactionIndex: '0x0', logIndex: '0x0', removed: false }
    result = { status: '0x1', transactionHash: req.params[0], blockHash: `0x${'b'.repeat(64)}`, blockNumber: '0x1', transactionIndex: '0x0', from: chain.treasuryAddress(), to: contract, cumulativeGasUsed: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1', logsBloom: `0x${'0'.repeat(512)}`, logs: [log, { ...log, address: factory }], type: '0x2' }
  } else throw new Error(`Unexpected RPC ${req.method}`)
  return Response.json({ jsonrpc: '2.0', id: req.id, result })
}
async function proof(user, issuedAt = Date.now()) { return { issuedAt, signature: await owner.signMessage({ message: walletClaimerMessage(user.id, owner.address, contract, issuedAt) }) } }
let user

test('new Celo accounts need no key provider; preparation spends no gas and validates the factory', async () => {
  process.env.WALLET_KEY_PROVIDER = 'aws-kms' // deliberately no KMS credentials
  user = await users.createUser()
  assert.equal(user.agentKeyEnc, 'keyless')
  await assert.rejects(wallets.agentKey(user), /no agent private key/)
  await users.updateUser(user.id, { rootAddress: owner.address })
  user = await users.getUserById(user.id)
  token = zeroAddress
  await assert.rejects(claimers.prepareClaimer(user), /does not match/)
  token = chain.GD.token
  user = await claimers.prepareClaimer(user)
  assert.equal(user.claimerAddress, contract)
  assert.equal(user.claimerActive, false)
  assert.equal(calls.length, 0)
  assert.equal((await wallets.custodyStatus()).wallets, 0)
  assert.deepEqual(await wallets.rewrapAgentKeys(), { moved: 0, failed: 0, pending: 0 })
  delete process.env.WALLET_KEY_PROVIDER
})

test('public contract links cannot hijack onboarding: account-bound fresh owner signature is mandatory', async () => {
  roots.set(contract.toLowerCase(), owner.address)
  await assert.rejects(claimers.activateClaimer(user), /signature/)
  await assert.rejects(claimers.activateClaimer(user, await proof(user, Date.now() - 600000)), /signature/)
  const wrongAccountProof = await proof({ ...user, id: 'another-account' })
  await assert.rejects(claimers.activateClaimer(user, wrongAccountProof), /must come from/)
  assert.equal((await run('SELECT * FROM wallet_bindings')).rows.length, 0)
  roots.clear()
  await assert.rejects(claimers.activateClaimer(user, await proof(user)), /Link the new/)
  assert.equal(calls.length, 0)
})

test('migration requires removal of old identity access, direct treasury allowances and pending transfers', async () => {
  await run("UPDATE users SET agent_key_enc = 'legacy-test' WHERE id = ?", [user.id])
  user = await users.getUserById(user.id)
  roots.set(contract.toLowerCase(), owner.address)
  roots.set(user.agentAddress.toLowerCase(), owner.address)
  await assert.rejects(claimers.activateClaimer(user, await proof(user)), /Unlink your old/)
  roots.delete(user.agentAddress.toLowerCase())
  allowance = 1n
  await assert.rejects(claimers.activateClaimer(user, await proof(user)), /Revoke the old direct/)
  allowance = 0n
  await run("INSERT INTO chain_transactions (id, sender, intent, raw, hash, created_at) VALUES ('pending-legacy', ?, '{}', '0x', '0xabc', 0)", [user.agentAddress.toLowerCase()])
  await assert.rejects(claimers.activateClaimer(user, await proof(user)), /still pending/)
  await run("UPDATE chain_transactions SET status = 'confirmed' WHERE id = 'pending-legacy'")
  assert.equal(calls.length, 0)
})

test('activation deploys once, retains recovery keys, and survives removal of the factory flag', async () => {
  user = await claimers.activateClaimer(user, await proof(user))
  assert.equal(user.claimerActive, true)
  assert.equal(user.connected, true)
  assert.equal(user.agentKeyEnc, 'legacy-test')
  assert.equal(calls.length, 1)
  assert.equal(decodeFunctionData({ abi: claimers.claimerFactoryAbi, data: calls[0].input.data }).functionName, 'create')
  delete process.env.CLAIMER_FACTORY_ADDRESS
  assert.equal((await claimers.activateClaimer(user)).claimerActive, true)
  assert.equal(calls.length, 1)
  assert.equal((await authorizedUser(user)).claimerActive, true)
  roots.delete(contract.toLowerCase())
  await assert.rejects(authorizedUser(user), /link has changed/)
  roots.set(contract.toLowerCase(), owner.address)
})

test('keyless claims use the sponsor, parse only the claimer receipt and recover despite zero entitlement', async () => {
  calls = []
  const first = await claimers.claimViaContract(user, 'claim-contract-test')
  assert.equal(first.amount, parseEther('100'))
  assert.equal(calls[0].key, process.env.TREASURY_PRIVATE_KEY)
  assert.equal(calls[0].input.to, contract)
  entitlement = 0n
  assert.deepEqual(await claimers.claimViaContract(user, 'claim-contract-test'), first)
  assert.equal(await claimers.claimViaContract(user, 'new-empty-claim'), null)
  assert.equal(claimers.rewardAddress(user), owner.address)
  assert.equal(claimers.claimAddress(user), contract)
})

test('upgraded spending ignores legacy funds and raw allowances; it fails closed without the policy contract', async () => {
  allowance = parseEther('9999')
  const power = await spend.spendingPower(user)
  assert.equal(power.mode, 'wallet')
  assert.equal(power.agentWei, agentBalance)
  assert.equal(power.totalWei, available)
  delete process.env.SPENDING_CONTRACT_ADDRESS
  assert.equal((await spend.spendingPower(user)).totalWei, 0n)
  await assert.rejects(chain.pullGdFromWallet(owner.address, 10n, 'protected-payment', true), /not configured/)
  process.env.SPENDING_CONTRACT_ADDRESS = policy
  calls = []
  await chain.pullGdFromWallet(owner.address, 10n, 'protected-payment', true)
  assert.equal(calls[0].input.to, policy)
  const decoded = decodeFunctionData({ abi: spendingPolicyAbi, data: calls[0].input.data })
  assert.equal(decoded.functionName, 'charge')
  assert.equal(decoded.args[1], 10n)
  assert.equal(calls[0].input.transfer.to, chain.treasuryAddress())
})

test('daily claims and streak rewards never use a migrated agent key, and retries do not pay twice', async () => {
  const daily = require('../src/lib/daily.ts')
  entitlement = parseEther('100')
  process.env.STREAK_REWARD_DAYS = '1'
  const originalAgentKey = wallets.agentKey
  wallets.agentKey = async () => { throw new Error('Migrated account must not decrypt an agent key') }
  calls = []
  try {
    const result = await daily.runDaily(user)
    assert.equal(result.claimed, parseEther('100'))
    assert.equal(result.reward, parseEther('500'))
    const reward = calls.find(c => c.id.startsWith('streak:'))
    assert.equal(reward.input.transfer.to, owner.address)
    const retry = await daily.runDaily(await users.getUserById(user.id))
    assert.equal(retry.claimed, 0n)
    assert.equal(retry.reward, 0n)
    assert.equal(calls.filter(c => c.id.startsWith('streak:')).length, 1)
    assert.equal(String((await run('SELECT gas_owed_wei FROM users WHERE id = ?', [user.id])).rows[0].gas_owed_wei), '0')
  } finally { wallets.agentKey = originalAgentKey; delete process.env.STREAK_REWARD_DAYS }
})

test('reward recovery keeps the signed destination when migration happens between transfer and recording', async () => {
  const id = `reward:${user.id}:old-signed-reward`
  const intent = JSON.stringify({ transfer: { to: user.agentAddress } })
  await run("INSERT INTO chain_transactions (id, sender, intent, raw, hash, created_at) VALUES (?, ?, ?, '0x', '0xdef', 0)", [id, chain.treasuryAddress().toLowerCase(), intent])
  assert.equal(await claimers.rewardDestination(user, id), user.agentAddress)
  assert.equal(await claimers.rewardDestination(user, `reward:${user.id}:new-reward`), owner.address)
})

test('old gas debt stays reserved and is never appended to a newly approved purchase', async () => {
  await run('UPDATE users SET gas_owed_wei = ? WHERE id = ?', [String(parseEther('10')), user.id])
  await run("UPDATE jars SET balance_wei = ? WHERE user_id = ? AND kind = 'ai'", [String(parseEther('100')), user.id])
  calls = []
  await spend.spendGd(user, parseEther('50'), { id: 'quoted-only', jar: 'ai' })
  const sent = calls.find(c => c.id === 'charge:quoted-only')
  assert.equal(sent.input.transfer.amount, String(parseEther('50')))
  assert.equal(String((await run('SELECT gas_owed_wei FROM users WHERE id = ?', [user.id])).rows[0].gas_owed_wei), String(parseEther('10')))
})

after(async () => { global.fetch = originalFetch; (await db()).close(); rmSync(directory, { recursive: true, force: true }) })
