import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { serverConfig } from './env'

// Each user gets their own agent wallet. The user's verified GoodDollar wallet
// connects it to their identity (IdentityV4.connectAccount), which lets the
// agent claim that user's daily UBI. Keys are AES-256-GCM encrypted at rest.

function key(): Buffer {
  const secret = serverConfig().walletSecret
  if (/^[0-9a-f]{64}$/i.test(secret)) return Buffer.from(secret, 'hex')
  if (process.env.NODE_ENV === 'production') throw new Error('WALLET_ENCRYPTION_KEY must be 64 hex chars')
  // Dev only: a fixed derived key so local data survives restarts.
  return createHash('sha256').update('jarra-dev-only-key').digest()
}

export function createAgentWallet(): { address: `0x${string}`; encryptedKey: string } {
  const pk = generatePrivateKey()
  return { address: privateKeyToAccount(pk).address, encryptedKey: encrypt(pk) }
}

export function decryptAgentKey(encrypted: string): `0x${string}` {
  const [ivHex, tagHex, dataHex] = encrypted.split('.')
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  const plain = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()])
  return plain.toString('utf8') as `0x${string}`
}

function encrypt(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), data.toString('hex')].join('.')
}
