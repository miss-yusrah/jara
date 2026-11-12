import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { isKeyProvider, keyProvider, localKek, type KeyProviderName } from './custody'
import { run } from './db'
import { serverConfig } from './env'

// Legacy users have an agent wallet. The user's verified GoodDollar wallet
// connects it to their identity (IdentityV4.connectAccount), which lets the
// agent claim that user's daily UBI.
//
// Custody of its key:
//   - Every wallet key is encrypted with its own random 256-bit data key (AES-256-GCM),
//     bound to that wallet's address. No key is shared between two wallets.
//   - The data key is stored only wrapped by the key provider (custody.ts). In production
//     that can be AWS KMS: the wrapping key never leaves the HSM. A database-only
//     leak cannot unwrap it; usable server IAM credentials can still authorize KMS.
//   - The owner can export the key after proving control of their verified GoodDollar
//     wallet (api/wallet/key), so they are never locked out of their own wallet.
//
// Stored form:  v2.<provider>.<wrapped data key>.<iv>.<tag>.<ciphertext>   (base64url)
// Older rows:   <iv>.<tag>.<ciphertext> in hex, all under the one WALLET_ENCRYPTION_KEY.
//               They are re-encrypted in the new form the first time they are used.

type PrivateKey = `0x${string}`
type Wallet = { id: string; agentAddress: string; agentKeyEnc: string }

const b64 = (b: Buffer) => b.toString('base64url')
const aad = (address: string) => Buffer.from(`jara:agent-key:v2:${address.toLowerCase()}`)

export async function createAgentWallet(): Promise<{ address: PrivateKey; encryptedKey: string }> {
  const pk = generatePrivateKey()
  const address = privateKeyToAccount(pk).address
  return { address, encryptedKey: await sealAgentKey(pk, address) }
}

/** Encrypt a wallet key under a fresh data key, wrapped by the configured key provider. */
export async function sealAgentKey(pk: PrivateKey, address: string, providerName: KeyProviderName = serverConfig().custody.provider): Promise<string> {
  const dataKey = randomBytes(32)
  try {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv)
    cipher.setAAD(aad(address))
    const data = Buffer.concat([cipher.update(pk, 'utf8'), cipher.final()])
    const wrapped = await keyProvider(providerName).wrap(dataKey, { wallet: address })
    return ['v2', providerName, b64(wrapped), b64(iv), b64(cipher.getAuthTag()), b64(data)].join('.')
  } finally {
    dataKey.fill(0)
  }
}

/** Which key protects a stored wallet key: "legacy" (the one shared key) or the provider name. */
export function keyProtection(encrypted: string): 'legacy' | KeyProviderName {
  const [version, provider] = encrypted.split('.')
  if (version !== 'v2') return 'legacy'
  if (!isKeyProvider(provider)) throw new Error('Unknown wallet key provider in stored key')
  return provider
}

async function open(encrypted: string, address: string): Promise<PrivateKey> {
  const protection = keyProtection(encrypted)
  let plain: Buffer
  if (protection === 'legacy') {
    const [ivHex, tagHex, dataHex] = encrypted.split('.')
    const decipher = createDecipheriv('aes-256-gcm', localKek(), Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    plain = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()])
  } else {
    const [, , wrapped, iv, tag, data] = encrypted.split('.').map((part, i) => (i < 2 ? Buffer.alloc(0) : Buffer.from(part, 'base64url')))
    const dataKey = await keyProvider(protection).unwrap(wrapped, { wallet: address })
    try {
      const decipher = createDecipheriv('aes-256-gcm', dataKey, iv)
      decipher.setAAD(aad(address))
      decipher.setAuthTag(tag)
      plain = Buffer.concat([decipher.update(data), decipher.final()])
    } finally {
      dataKey.fill(0)
    }
  }
  const pk = plain.toString('utf8') as PrivateKey
  if (privateKeyToAccount(pk).address.toLowerCase() !== address.toLowerCase()) throw new Error('Stored wallet key does not match its wallet address')
  return pk
}

/**
 * The agent wallet's signing key, for one claim or transfer. Never cached.
 * A row still protected by something other than the configured provider is moved
 * across here, after the new form has been proven to decrypt.
 */
export async function agentKey(wallet: Wallet): Promise<PrivateKey> {
  if (wallet.agentKeyEnc === 'keyless') throw new Error('This account uses a claim contract and has no agent private key.')
  const pk = await open(wallet.agentKeyEnc, wallet.agentAddress)
  if (keyProtection(wallet.agentKeyEnc) !== serverConfig().custody.provider) {
    await rewrap(wallet, pk).catch((err) => console.warn('[custody] re-wrap deferred', wallet.id, err instanceof Error ? err.message : 'error'))
  }
  return pk
}

async function rewrap(wallet: Wallet, pk: PrivateKey) {
  const sealed = await sealAgentKey(pk, wallet.agentAddress)
  if ((await open(sealed, wallet.agentAddress)) !== pk) throw new Error('re-wrapped key failed verification')
  // Compare-and-swap, so a concurrent writer is never overwritten.
  await run('UPDATE users SET agent_key_enc = ? WHERE id = ? AND agent_key_enc = ?', [sealed, wallet.id, wallet.agentKeyEnc])
}

/** How many wallet keys each kind of key protects. Contains no key material. */
export async function custodyStatus(): Promise<{ provider: KeyProviderName; wallets: number; byProtection: Record<string, number>; pending: number }> {
  const provider = serverConfig().custody.provider
  const rows = (await run("SELECT CASE WHEN agent_key_enc LIKE 'v2.%' THEN substr(agent_key_enc, 4, instr(substr(agent_key_enc, 4), '.') - 1) ELSE 'legacy' END AS protection, COUNT(*) AS n FROM users WHERE agent_key_enc != 'keyless' GROUP BY protection")).rows
  const byProtection = Object.fromEntries(rows.map((r) => [String(r.protection), Number(r.n)]))
  const wallets = Object.values(byProtection).reduce((a, b) => a + b, 0)
  return { provider, wallets, byProtection, pending: wallets - (byProtection[provider] ?? 0) }
}

/**
 * Move wallet keys that are not yet under the configured provider (bounded per call so a
 * cron run stays short). Safe to repeat; each row is verified before it replaces the old one.
 */
export async function rewrapAgentKeys(limit = 200): Promise<{ moved: number; failed: number; pending: number }> {
  const provider = serverConfig().custody.provider
  const rows = (await run("SELECT id, agent_address, agent_key_enc FROM users WHERE agent_key_enc != 'keyless' AND agent_key_enc NOT LIKE ? LIMIT ?", [`v2.${provider}.%`, limit])).rows
  let moved = 0
  let failed = 0
  for (const r of rows) {
    const wallet = { id: String(r.id), agentAddress: String(r.agent_address), agentKeyEnc: String(r.agent_key_enc) }
    try {
      await rewrap(wallet, await open(wallet.agentKeyEnc, wallet.agentAddress))
      moved++
    } catch (err) {
      failed++
      console.error('[custody] could not re-wrap wallet key', wallet.id, err instanceof Error ? err.message : 'error')
    }
  }
  return { moved, failed, pending: (await custodyStatus()).pending }
}
