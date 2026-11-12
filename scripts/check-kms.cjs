/* eslint-disable @typescript-eslint/no-require-imports */
// Proves the AWS KMS settings work before any wallet key depends on them.
//
//   node --env-file=.env.production.local --require ./tests/register.cjs scripts/check-kms.cjs
//
// Wraps and unwraps a throwaway 32-byte key with the WALLET_KMS_* settings, then confirms KMS
// refuses to unwrap it for a different wallet. It reads no database and no wallet key, and it
// works while WALLET_KEY_PROVIDER is still "local", so run it before switching.
const { randomBytes } = require('node:crypto')
const { keyProvider } = require('../src/lib/custody.ts')

async function main() {
  const kms = keyProvider('aws-kms')
  const wallet = `0x${randomBytes(20).toString('hex')}`
  const dataKey = randomBytes(32)
  const wrapped = await kms.wrap(dataKey, { wallet })
  const unwrapped = await kms.unwrap(wrapped, { wallet })
  if (!unwrapped.equals(dataKey)) throw new Error('KMS returned a different key than the one it wrapped')
  const otherWallet = `0x${randomBytes(20).toString('hex')}`
  const crossed = await kms.unwrap(wrapped, { wallet: otherWallet }).then(() => true, () => false)
  if (crossed) throw new Error('KMS unwrapped a key for a wallet it was not wrapped for')
  console.log('KMS check passed: wrap, unwrap and per-wallet binding all work with these settings.')
}

main().catch((err) => {
  console.error(`KMS check failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
