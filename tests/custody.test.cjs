/* eslint-disable @typescript-eslint/no-require-imports */
// Agent-wallet key custody: per-wallet envelope encryption, the key provider boundary,
// migration of keys stored under the old single key, and the owner's key export.
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { createCipheriv, randomBytes } = require('node:crypto')
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts')
const directory = mkdtempSync(`${tmpdir()}/jara-custody-`)
Object.assign(process.env, { DATABASE_URL: `file:${directory}/test.db`, CHAIN_MODE: 'mock', TOPUP_PROVIDER: 'mock', WALLET_ENCRYPTION_KEY: 'ab'.repeat(32), TREASURY_PRIVATE_KEY: `0x${'1'.repeat(64)}` })
delete process.env.WALLET_KEY_PROVIDER
const { db, run } = require('../src/lib/db.ts')
const users = require('../src/lib/users.ts')
const chain = require('../src/lib/chain.ts')
const custody = require('../src/lib/custody.ts')
const wallets = require('../src/lib/wallets.ts')
const session = require('../src/lib/session.ts')
const { walletKeyExportMessage } = require('../src/lib/wallet-login.ts')
const keyRoute = require('../src/app/api/wallet/key/route.ts')

const stored = async (id) => String((await run('SELECT agent_key_enc FROM users WHERE id = ?', [id])).rows[0].agent_key_enc)

/** A wallet key stored the way it was before this change: one shared key, no per-wallet key. */
function legacyEncrypt(pk) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(process.env.WALLET_ENCRYPTION_KEY, 'hex'), iv)
  const data = Buffer.concat([cipher.update(pk, 'utf8'), cipher.final()])
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), data.toString('hex')].join('.')
}

/** Stands in for AWS KMS: wraps under a key this process's "server" never sees, and enforces the encryption context. */
function fakeKms() {
  const state = { calls: [], deny: false, contexts: [] }
  const original = global.fetch
  global.fetch = async (url, init) => {
    const action = init.headers['x-amz-target'].split('.')[1]
    const body = JSON.parse(init.body)
    state.calls.push({ url: String(url), action, authorization: init.headers.authorization, keyId: body.KeyId })
    state.contexts.push(body.EncryptionContext)
    if (state.deny) return Response.json({ __type: 'AccessDeniedException', message: 'not authorized' }, { status: 400 })
    if (action === 'Encrypt') return Response.json({ CiphertextBlob: Buffer.from(JSON.stringify({ sealed: body.Plaintext, context: body.EncryptionContext })).toString('base64') })
    const blob = JSON.parse(Buffer.from(body.CiphertextBlob, 'base64').toString())
    if (JSON.stringify(blob.context) !== JSON.stringify(body.EncryptionContext)) return Response.json({ __type: 'InvalidCiphertextException' }, { status: 400 })
    return Response.json({ Plaintext: blob.sealed })
  }
  return { state, restore: () => { global.fetch = original } }
}
const KMS_ENV = { WALLET_KEY_PROVIDER: 'aws-kms', WALLET_KMS_KEY_ID: 'alias/jara-wallets', WALLET_KMS_REGION: 'eu-west-1', WALLET_KMS_ACCESS_KEY_ID: 'AKIDEXAMPLE', WALLET_KMS_SECRET_ACCESS_KEY: 'secret' }
const useKms = () => Object.assign(process.env, KMS_ENV)
const useLocal = () => { for (const key of Object.keys(KMS_ENV)) delete process.env[key] }

test('request signing matches the AWS Signature Version 4 reference vector', () => {
  const signed = custody.signAwsRequest({ method: 'GET', host: 'example.amazonaws.com', path: '/', region: 'us-east-1', service: 'service', headers: {}, body: '', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', amzDate: '20150830T123600Z' })
  assert.equal(signed.canonicalRequestHash, 'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63')
  assert.equal(signed.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31')
})

test('every wallet key has its own data key and is bound to its own wallet', async () => {
  const a = await users.createUser()
  const b = await users.createUser()
  assert.match(a.agentKeyEnc, /^v2\.local\./)
  assert.notEqual(a.agentKeyEnc.split('.')[2], b.agentKeyEnc.split('.')[2], 'wrapped data keys differ per wallet')
  const pk = await wallets.agentKey(a)
  assert.equal(privateKeyToAccount(pk).address, a.agentAddress)
  assert.ok(!a.agentKeyEnc.includes(pk.slice(2)))
  // Another wallet's ciphertext cannot be swapped into this row, and a modified one is rejected.
  await assert.rejects(wallets.agentKey({ ...a, agentKeyEnc: b.agentKeyEnc }))
  const parts = a.agentKeyEnc.split('.')
  parts[5] = Buffer.from(Buffer.from(parts[5], 'base64url').map((byte, i) => (i === 0 ? byte ^ 1 : byte))).toString('base64url')
  await assert.rejects(wallets.agentKey({ ...a, agentKeyEnc: parts.join('.') }))
})

test('keys stored under the old single key are re-encrypted per wallet, on use and in bulk', async () => {
  const made = []
  for (let i = 0; i < 3; i++) {
    const user = await users.createUser()
    const pk = generatePrivateKey()
    const address = privateKeyToAccount(pk).address
    await run('UPDATE users SET agent_address = ?, agent_key_enc = ? WHERE id = ?', [address, legacyEncrypt(pk), user.id])
    made.push({ user: await users.getUserById(user.id), pk })
  }
  assert.equal(wallets.keyProtection(made[0].user.agentKeyEnc), 'legacy')
  assert.ok((await wallets.custodyStatus()).byProtection.legacy >= 3)
  // First use returns the same key and moves that row.
  assert.equal(await wallets.agentKey(made[0].user), made[0].pk)
  assert.match(await stored(made[0].user.id), /^v2\.local\./)
  assert.equal(await wallets.agentKey(await users.getUserById(made[0].user.id)), made[0].pk)
  // The scheduled sweep moves the rest.
  const sweep = await wallets.rewrapAgentKeys()
  assert.equal(sweep.failed, 0)
  assert.equal(sweep.pending, 0)
  for (const { user, pk } of made) assert.equal(await wallets.agentKey(await users.getUserById(user.id)), pk)
  assert.equal((await wallets.custodyStatus()).byProtection.legacy, undefined)
})

test('with the KMS provider the database and the server key together decrypt nothing', async () => {
  const kms = fakeKms()
  useKms()
  try {
    const user = await users.createUser()
    assert.match(user.agentKeyEnc, /^v2\.aws-kms\./)
    const pk = await wallets.agentKey(user)
    assert.equal(privateKeyToAccount(pk).address, user.agentAddress)
    // Each call is signed, goes to the configured key, and names the one wallet it is for.
    const last = kms.state.calls.at(-1)
    assert.equal(last.url, 'https://kms.eu-west-1.amazonaws.com/')
    assert.equal(last.action, 'Decrypt')
    assert.equal(last.keyId, 'alias/jara-wallets')
    assert.match(last.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/kms\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/)
    assert.deepEqual(kms.state.contexts.at(-1), { app: 'jara', purpose: 'agent-wallet-key', wallet: user.agentAddress.toLowerCase() })
    // Once KMS access is revoked, everything still on the server (database row + WALLET_ENCRYPTION_KEY) opens nothing.
    kms.state.deny = true
    await assert.rejects(wallets.agentKey(user), /KMS Decrypt failed: AccessDeniedException/)
    kms.state.deny = false
    // A wrapped data key is useless for any other wallet.
    const other = await users.createUser()
    const swapped = other.agentKeyEnc.split('.')
    swapped[2] = user.agentKeyEnc.split('.')[2]
    await assert.rejects(wallets.agentKey({ ...other, agentKeyEnc: swapped.join('.') }), /InvalidCiphertextException/)
  } finally { useLocal(); kms.restore() }
})

test('existing wallets move from the server-held key to KMS without changing the key or losing a row', async () => {
  const before = await users.createUser()
  const pk = await wallets.agentKey(before)
  const kms = fakeKms()
  useKms()
  try {
    assert.ok((await wallets.custodyStatus()).pending > 0)
    // If KMS is unreachable nothing is overwritten.
    kms.state.deny = true
    const blocked = await wallets.rewrapAgentKeys()
    assert.equal(blocked.moved, 0)
    assert.equal(await stored(before.id), before.agentKeyEnc)
    kms.state.deny = false
    const sweep = await wallets.rewrapAgentKeys(1000)
    assert.equal(sweep.failed, 0)
    assert.equal(sweep.pending, 0)
    assert.match(await stored(before.id), /^v2\.aws-kms\./)
    assert.equal(await wallets.agentKey(await users.getUserById(before.id)), pk)
  } finally { useLocal(); kms.restore() }
})

test('the owner can export their key only with a fresh signature from their verified wallet', async () => {
  const owner = privateKeyToAccount(generatePrivateKey())
  let user = await users.createUser()
  await users.updateUser(user.id, { connected: true, rootAddress: owner.address })
  user = await users.getUserById(user.id)
  const originals = { requireUser: session.requireUser, verify: chain.verifyWalletSignature }
  session.requireUser = async () => user
  // Local signature recovery in place of the RPC-backed check (which also covers contract wallets).
  const { verifyMessage } = require('viem')
  chain.verifyWalletSignature = (address, message, signature) => verifyMessage({ address, message, signature })
  const call = (body) => keyRoute.POST(new Request('http://localhost/api/wallet/key', { method: 'POST', body: JSON.stringify(body) }))
  const sign = (account, issuedAt, agent = user.agentAddress) => account.signMessage({ message: walletKeyExportMessage(owner.address, agent, issuedAt) })
  try {
    // Demo wallets have nothing to export.
    assert.equal((await call({ issuedAt: Date.now(), signature: '0x00' })).status, 404)
    process.env.CHAIN_MODE = 'celo'
    const issuedAt = Date.now()
    // Being signed in is not enough.
    assert.equal((await call({})).status, 400)
    // Someone else's wallet, a signature for a different Jara wallet, and an old signature are all refused.
    const stranger = privateKeyToAccount(generatePrivateKey())
    assert.equal((await call({ issuedAt, signature: await sign(stranger, issuedAt) })).status, 401)
    assert.equal((await call({ issuedAt, signature: await sign(owner, issuedAt, stranger.address) })).status, 401)
    const old = Date.now() - 10 * 60_000
    assert.equal((await call({ issuedAt: old, signature: await sign(owner, old) })).status, 400)

    const signature = await sign(owner, issuedAt)
    const response = await call({ issuedAt, signature })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = await response.json()
    assert.equal(privateKeyToAccount(body.privateKey).address, user.agentAddress)
    // The same signature cannot be replayed, and the export is on the user's activity log.
    assert.equal((await call({ issuedAt, signature })).status, 400)
    assert.equal(Number((await run("SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND title LIKE '%wallet key%'", [user.id])).rows[0].n), 1)
    // An account that has not linked a verified wallet has no owner to prove.
    const unlinked = await users.createUser()
    session.requireUser = async () => unlinked
    assert.equal((await call({ issuedAt, signature })).status, 400)
  } finally { process.env.CHAIN_MODE = 'mock'; Object.assign(session, { requireUser: originals.requireUser }); chain.verifyWalletSignature = originals.verify }
})

test('claimed G$ is forwarded to the owner\'s own wallet, so the wallet Jara holds a key for stays empty', async () => {
  const spend = require('../src/lib/spend.ts')
  const { parseEther } = require('viem')
  const gd = (n) => parseEther(String(n))
  const owner = privateKeyToAccount(generatePrivateKey()).address
  let user = await users.createUser()
  await users.updateUser(user.id, { connected: true, rootAddress: owner })
  user = await users.getUserById(user.id)
  const originals = { balanceBlock: chain.balanceBlock, whitelistedRoot: chain.whitelistedRoot, gdBalance: chain.gdBalance, gdAllowance: chain.gdAllowance, transferFromAgent: chain.transferFromAgent }
  const world = { agent: gd(126), wallet: gd(40), allowance: gd(5000), sends: [] }
  chain.balanceBlock = async () => undefined
  chain.whitelistedRoot = async () => owner
  chain.gdBalance = async (address) => (address.toLowerCase() === user.agentAddress.toLowerCase() ? world.agent : world.wallet)
  chain.gdAllowance = async () => world.allowance
  chain.transferFromAgent = async (key, to, amount) => {
    assert.equal(privateKeyToAccount(key).address, user.agentAddress)
    world.sends.push({ to, amount })
    world.agent -= amount
    world.wallet += amount
    return { hash: `0x${String(world.sends.length).repeat(64)}`, feeWei: 0n }
  }
  process.env.CHAIN_MODE = 'celo'
  try {
    // Fees Jara fronted stay behind; everything else goes to the verified owner, nowhere else.
    await run("UPDATE users SET gas_owed_wei = ? WHERE id = ?", [String(gd(6)), user.id])
    const sent = await spend.forwardToOwner(user, 'day-1:claim')
    assert.equal(sent.amountWei, gd(120))
    assert.deepEqual(world.sends, [{ to: owner, amount: gd(120) }])
    assert.equal(world.agent, gd(6))
    // The same occasion never sends twice, and it is on the activity log once.
    await spend.forwardToOwner(user, 'day-1:claim')
    assert.equal(world.sends.length, 1)
    assert.equal(Number((await run("SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND type = 'move'", [user.id])).rows[0].n), 1)
    // Too little to be worth a network fee: wait.
    world.agent = gd(6 + 5)
    assert.equal(await spend.forwardToOwner(user, 'day-2:claim'), null)
    // The next claim goes out again.
    world.agent = gd(6 + 126)
    assert.equal((await spend.forwardToOwner(user, 'day-3:claim')).amountWei, gd(126))
    // Someone who has not approved a spending limit pays from the Jara wallet: it is left alone.
    world.agent = gd(500)
    world.allowance = 0n
    assert.equal(await spend.forwardToOwner(user, 'day-4:claim'), null)
    // And it can be switched off.
    world.allowance = gd(5000)
    process.env.FORWARD_CLAIMS = 'false'
    assert.equal(await spend.forwardToOwner(user, 'day-5:claim'), null)
    assert.equal(world.sends.length, 2)
  } finally { delete process.env.FORWARD_CLAIMS; process.env.CHAIN_MODE = 'mock'; Object.assign(chain, originals) }
})

test('the daily run claims, then leaves the claimed G$ in the owner\'s wallet and budgets from there', async () => {
  const daily = require('../src/lib/daily.ts')
  const jars = require('../src/lib/jars.ts')
  const { parseEther } = require('viem')
  const gd = (n) => parseEther(String(n))
  const owner = privateKeyToAccount(generatePrivateKey()).address
  let user = await users.createUser()
  await users.updateUser(user.id, { connected: true, rootAddress: owner })
  user = await users.getUserById(user.id)
  const originals = { balanceBlock: chain.balanceBlock, whitelistedRoot: chain.whitelistedRoot, gdBalance: chain.gdBalance, gdAllowance: chain.gdAllowance, transferFromAgent: chain.transferFromAgent, claimUbi: chain.claimUbi }
  const world = { agent: 0n, wallet: 0n, allowance: gd(5000), sends: [] }
  chain.balanceBlock = async () => undefined
  chain.whitelistedRoot = async () => owner
  chain.gdBalance = async (address) => (address.toLowerCase() === user.agentAddress.toLowerCase() ? world.agent : world.wallet)
  chain.gdAllowance = async () => world.allowance
  chain.claimUbi = async () => { world.agent += gd(126); return { amount: gd(126), hash: `0x${'c'.repeat(64)}`, feeWei: 10n ** 15n } }
  chain.transferFromAgent = async (key, to, amount) => { world.sends.push({ to, amount }); world.agent -= amount; world.wallet += amount; return { hash: `0x${'d'.repeat(64)}`, feeWei: 0n } }
  Object.assign(process.env, { CHAIN_MODE: 'celo', GD_NGN_RATE: '1', GD_PER_CELO: '1000' })
  try {
    const result = await daily.runDaily(user)
    assert.equal(result.claimed, gd(126))
    // The claim's network fee (0.001 CELO = G$ 1) stays behind to be repaid; the rest is the owner's.
    assert.deepEqual(world.sends, [{ to: owner, amount: gd(125) }])
    assert.equal(world.agent, gd(1))
    assert.match(result.message, /own wallet/)
    const budgeted = (await jars.getJars(user.id)).reduce((sum, jar) => sum + jar.balanceWei, 0n)
    assert.ok(budgeted > 0n && budgeted <= gd(125), 'jars are budgets of the G$ now in the owner\'s wallet')
    // A second run the same day neither claims nor sends again.
    await daily.runDaily(await users.getUserById(user.id))
    assert.equal(world.sends.length, 1)
  } finally { Object.assign(chain, originals); process.env.CHAIN_MODE = 'mock'; delete process.env.GD_NGN_RATE; delete process.env.GD_PER_CELO }
})

after(async () => { (await db()).close(); rmSync(directory, { recursive: true, force: true }) })
