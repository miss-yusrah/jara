// Deploys JaraTelemetry to Celo mainnet from TELEMETRY_REPORTER_KEY (deployer = owner = reporter).
// Usage on the server: node scripts/deploy-telemetry.mjs   (reads .env.production.local)
import fs from 'node:fs'
import { createPublicClient, createWalletClient, http, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'

const envFile = fs.existsSync('.env.production.local') ? '.env.production.local' : '.env.local'
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}
const key = process.env.TELEMETRY_REPORTER_KEY
if (!key) throw new Error('TELEMETRY_REPORTER_KEY missing')
if (process.env.TELEMETRY_CONTRACT) throw new Error(`Already deployed: ${process.env.TELEMETRY_CONTRACT}`)
const art = JSON.parse(fs.readFileSync('contracts/artifacts/JaraTelemetry.json', 'utf8'))
const account = privateKeyToAccount(key)
const transport = http(process.env.CELO_RPC_URL || 'https://forno.celo.org')
const pub = createPublicClient({ chain: celo, transport })
const wallet = createWalletClient({ account, chain: celo, transport })
const bal = await pub.getBalance({ address: account.address })
console.log('deployer', account.address, 'balance', formatEther(bal), 'CELO')
if (bal === 0n) throw new Error('Fund the deployer with CELO first')
const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [account.address] })
console.log('tx', hash)
const r = await pub.waitForTransactionReceipt({ hash })
if (r.status !== 'success' || !r.contractAddress) throw new Error('deploy failed')
fs.appendFileSync(envFile, `\nTELEMETRY_CONTRACT=${r.contractAddress}\n`)
console.log('JaraTelemetry deployed at', r.contractAddress)
