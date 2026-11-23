// Prepare with: forge build --root contracts
// Explicit deployment: node --env-file=.env.production.local scripts/deploy-daily-challenge.mjs YYYY-MM-DD YYYY-MM-DD --funded
// Never writes keys or modifies the environment file. Run only after reserving the prize budget.
import fs from 'node:fs'
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'

const [startDate, endDate, funded] = process.argv.slice(2)
function day(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) throw new Error('Use YYYY-MM-DD dates in Lagos time.')
  const ms = Date.parse(`${value}T00:00:00Z`)
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new Error('Invalid date.')
  return Math.floor(ms / 86400000)
}
const start = day(startDate), end = day(endDate)
if (start < Math.floor((Date.now() + 3600000) / 86400000) || end < start || end - start >= 90) throw new Error('Choose a future campaign lasting 1–90 days.')
if (funded !== '--funded') throw new Error(`Reserve ₦${(end - start + 1) * 5000} for airtime, then pass --funded.`)
if (process.env.CHAIN_MODE !== 'celo') throw new Error('Live Celo configuration is required.')
if (process.env.DAILY_CHALLENGE_CONTRACT) throw new Error('A campaign is already configured. Finish existing obligations before switching contracts.')
const signerKey = process.env.DAILY_CHALLENGE_SIGNER_KEY
const deployKey = process.env.DAILY_CHALLENGE_DEPLOYER_KEY
if (!signerKey || !deployKey) throw new Error('Set separate DAILY_CHALLENGE_SIGNER_KEY and DAILY_CHALLENGE_DEPLOYER_KEY.')
const signer = privateKeyToAccount(signerKey)
const account = privateKeyToAccount(deployKey)
if (account.address === signer.address) throw new Error('Use separate completion signer and owner keys.')
const artifact = JSON.parse(fs.readFileSync('contracts/out/JaraDailyChallenge.sol/JaraDailyChallenge.json', 'utf8'))
const transport = http(process.env.CELO_RPC_URL || 'https://forno.celo.org')
const pub = createPublicClient({ chain: celo, transport })
if (await pub.getChainId() !== celo.id) throw new Error('RPC must be Celo mainnet.')
const wallet = createWalletClient({ account, chain: celo, transport })
const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: ['0xC361A6E67822a0EDc17D899227dd9FC50BD62F42', signer.address, BigInt(start), BigInt(end)] })
console.log('Deployment transaction:', hash)
const receipt = await pub.waitForTransactionReceipt({ hash })
if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Deployment did not succeed.')
console.log('DAILY_CHALLENGE_CONTRACT=' + receipt.contractAddress)
console.log('Register this address with GoodDollar tracking and verify its source before enabling entries.')
