import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { serverConfig } from './env'

// Key-encryption keys (KEKs) for agent wallet keys.
//
// Every agent wallet key is encrypted under its own random data key (see wallets.ts).
// A KEK provider only ever wraps and unwraps one 32-byte data key at a time, bound to
// the wallet it belongs to:
//
//   aws-kms  The KEK is a key inside AWS KMS (an HSM). It cannot be read or exported by
//            this server or by anyone with the server's files. Each unwrap is a separate,
//            IAM-authorized and CloudTrail-logged call naming the wallet, and access can
//            be revoked from outside the server. This is the production setting.
//   local    The KEK is WALLET_ENCRYPTION_KEY in the server environment. For development
//            and tests, and readable by anyone who can read the server's environment.

export type KeyProviderName = 'local' | 'aws-kms'

/** Binds a wrapped data key to one wallet, so it cannot be replayed against another row. */
export type KeyContext = { wallet: string }

export interface KeyProvider {
  readonly name: KeyProviderName
  wrap(dataKey: Buffer, context: KeyContext): Promise<Buffer>
  unwrap(wrapped: Buffer, context: KeyContext): Promise<Buffer>
}

const contextFields = (context: KeyContext) => ({ app: 'jara', purpose: 'agent-wallet-key', wallet: context.wallet.toLowerCase() })

// ---------- local ----------

/** The server-held key. Also what keys written before per-wallet encryption were encrypted with. */
export function localKek(): Buffer {
  const secret = serverConfig().walletSecret
  if (/^[0-9a-f]{64}$/i.test(secret)) return Buffer.from(secret, 'hex')
  if (process.env.NODE_ENV === 'production' || serverConfig().chain.mode === 'celo') throw new Error('WALLET_ENCRYPTION_KEY must be 64 hex chars')
  // Dev only: a fixed derived key so local data survives restarts.
  return createHash('sha256').update('jarra-dev-only-key').digest()
}

const localProvider: KeyProvider = {
  name: 'local',
  async wrap(dataKey, context) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', localKek(), iv)
    cipher.setAAD(Buffer.from(JSON.stringify(contextFields(context))))
    const data = Buffer.concat([cipher.update(dataKey), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), data])
  },
  async unwrap(wrapped, context) {
    const decipher = createDecipheriv('aes-256-gcm', localKek(), wrapped.subarray(0, 12))
    decipher.setAAD(Buffer.from(JSON.stringify(contextFields(context))))
    decipher.setAuthTag(wrapped.subarray(12, 28))
    return Buffer.concat([decipher.update(wrapped.subarray(28)), decipher.final()])
  },
}

// ---------- AWS KMS ----------

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest()

/** AWS Signature Version 4 for a JSON POST. Exported for its test against AWS's published vector. */
export function signAwsRequest(input: {
  method: string
  host: string
  path: string
  region: string
  service: string
  headers: Record<string, string>
  body: string
  accessKeyId: string
  secretAccessKey: string
  /** YYYYMMDDTHHMMSSZ */
  amzDate: string
}): { authorization: string; canonicalRequestHash: string } {
  const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v.trim()])), host: input.host, 'x-amz-date': input.amzDate }
  const names = Object.keys(headers).sort()
  const canonical = [input.method, input.path, '', names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), sha256(input.body)].join('\n')
  const date = input.amzDate.slice(0, 8)
  const scope = `${date}/${input.region}/${input.service}/aws4_request`
  const canonicalRequestHash = sha256(canonical)
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), input.service), 'aws4_request')
  const signature = hmac(signingKey, ['AWS4-HMAC-SHA256', input.amzDate, scope, canonicalRequestHash].join('\n')).toString('hex')
  return { authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`, canonicalRequestHash }
}

async function kms(action: 'Encrypt' | 'Decrypt', payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cfg = serverConfig().custody.kms
  if (!cfg.keyId || !cfg.region || !cfg.accessKeyId || !cfg.secretAccessKey) {
    throw new Error('WALLET_KEY_PROVIDER=aws-kms needs WALLET_KMS_KEY_ID, WALLET_KMS_REGION, WALLET_KMS_ACCESS_KEY_ID and WALLET_KMS_SECRET_ACCESS_KEY')
  }
  const host = `kms.${cfg.region}.amazonaws.com`
  const body = JSON.stringify({ KeyId: cfg.keyId, ...payload })
  const headers: Record<string, string> = { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `TrentService.${action}` }
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '')
  const { authorization } = signAwsRequest({ method: 'POST', host, path: '/', region: cfg.region, service: 'kms', headers, body, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, amzDate })
  const res = await fetch(`https://${host}/`, { method: 'POST', headers: { ...headers, 'x-amz-date': amzDate, authorization }, body, signal: AbortSignal.timeout(15_000) })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  // KMS errors name the failure (AccessDenied, InvalidCiphertext…) and never contain key material.
  if (!res.ok) throw new Error(`KMS ${action} failed: ${String(json.__type ?? res.status).split('#').pop()}`)
  return json
}

const kmsProvider: KeyProvider = {
  name: 'aws-kms',
  async wrap(dataKey, context) {
    const r = await kms('Encrypt', { Plaintext: dataKey.toString('base64'), EncryptionContext: contextFields(context) })
    if (typeof r.CiphertextBlob !== 'string') throw new Error('KMS Encrypt returned no ciphertext')
    return Buffer.from(r.CiphertextBlob, 'base64')
  },
  async unwrap(wrapped, context) {
    const r = await kms('Decrypt', { CiphertextBlob: wrapped.toString('base64'), EncryptionContext: contextFields(context) })
    if (typeof r.Plaintext !== 'string') throw new Error('KMS Decrypt returned no plaintext')
    return Buffer.from(r.Plaintext, 'base64')
  },
}

const providers: Record<KeyProviderName, KeyProvider> = { local: localProvider, 'aws-kms': kmsProvider }

export const isKeyProvider = (name: unknown): name is KeyProviderName => typeof name === 'string' && name in providers

export function keyProvider(name: KeyProviderName = serverConfig().custody.provider): KeyProvider {
  return providers[name]
}
