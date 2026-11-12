// Run `forge build --root contracts --evm-version paris` first.
// Default: read-only deployment plan. --broadcast explicitly signs/broadcasts.
// Keys come only from the process environment (e.g. Node's --env-file option).
// A journal persists signed bytes BEFORE broadcast, making interrupted runs resumable.
import fs from 'node:fs'
import path from 'node:path'
import { createPublicClient, createWalletClient, encodeDeployData, formatEther, getAddress, http, keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'

const broadcast = process.argv.includes('--broadcast')
const journalFile = path.resolve(process.env.CUSTODY_DEPLOY_JOURNAL || 'output/custody-deployment.json')
const privateKey = process.env.CUSTODY_DEPLOYER_PRIVATE_KEY || process.env.TREASURY_PRIVATE_KEY
const account = privateKey ? privateKeyToAccount(privateKey) : null
const treasury = process.env.TREASURY_ADDRESS || (process.env.TREASURY_PRIVATE_KEY ? privateKeyToAccount(process.env.TREASURY_PRIVATE_KEY).address : null)
if (!treasury) throw new Error('Set TREASURY_ADDRESS (public) or TREASURY_PRIVATE_KEY to identify the operator and recipient.')
const operator = getAddress(treasury)
const deployer = account?.address || process.env.CUSTODY_DEPLOYER_ADDRESS || operator
if (broadcast && !account) throw new Error('--broadcast requires CUSTODY_DEPLOYER_PRIVATE_KEY or TREASURY_PRIVATE_KEY.')
const transport = http(process.env.CELO_RPC_URL || 'https://forno.celo.org')
const pc = createPublicClient({ chain: celo, transport })
if (await pc.getChainId() !== celo.id) throw new Error('Only Celo mainnet (42220) or its local fork is supported.')
const wallet = account ? createWalletClient({ account, chain: celo, transport }) : null
const token = '0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A'
const ubi = '0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1'
const deployments = [
  { name: 'JaraClaimerFactory', source: 'JaraClaimer', env: 'CLAIMER_FACTORY_ADDRESS', args: [ubi, token] },
  { name: 'JaraSpending', source: 'JaraSpending', env: 'SPENDING_CONTRACT_ADDRESS', args: [token, operator, operator] },
]
const journal = fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile, 'utf8')) : { chainId: celo.id, deployer, operator, contracts: {} }
if (journal.chainId !== celo.id || journal.deployer.toLowerCase() !== deployer.toLowerCase() || journal.operator.toLowerCase() !== operator.toLowerCase()) throw new Error('Deployment journal belongs to another chain, deployer or operator. Inspect it before proceeding.')
function save() {
  fs.mkdirSync(path.dirname(journalFile), { recursive: true })
  fs.writeFileSync(`${journalFile}.tmp`, JSON.stringify(journal, null, 2), { mode: 0o600 })
  fs.renameSync(`${journalFile}.tmp`, journalFile)
}
const plans = []
for (const deployment of deployments) {
  const artifact = JSON.parse(fs.readFileSync(`contracts/out/${deployment.source}.sol/${deployment.name}.json`, 'utf8'))
  if (artifact.metadata.settings.evmVersion !== 'paris') throw new Error('Rebuild production artifacts with --evm-version paris. Fork-test artifacts must not determine deployed addresses.')
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: deployment.args })
  const fingerprint = keccak256(data)
  const saved = journal.contracts[deployment.name]
  if (saved && saved.fingerprint !== fingerprint) throw new Error(`${deployment.name} differs from its signed deployment. Do not replace the journal to retry.`)
  if (process.env[deployment.env] && (!saved?.address || getAddress(process.env[deployment.env]) !== getAddress(saved.address))) throw new Error(`${deployment.env} is already set outside this journal; verify that deployment instead of redeploying.`)
  const gas = await pc.estimateGas({ account: deployer, data })
  plans.push({ ...deployment, artifact, data, fingerprint, gas })
}
const gasPrice = await pc.getGasPrice()
console.log(JSON.stringify({ mode: broadcast ? 'broadcast' : 'plan only — no transactions signed', chainId: celo.id, deployer, operator, estimatedCelo: formatEther(plans.reduce((sum, p) => sum + p.gas, 0n) * gasPrice), contracts: plans.map(p => ({ name: p.name, args: p.args, creationHash: p.fingerprint, estimatedGas: String(p.gas) })) }, null, 2))
if (!broadcast) process.exit(0)
for (const plan of plans) {
  let saved = journal.contracts[plan.name]
  if (!saved) {
    const prepared = await wallet.prepareTransactionRequest({ data: plan.data })
    const raw = await wallet.signTransaction(prepared)
    saved = journal.contracts[plan.name] = { fingerprint: plan.fingerprint, hash: keccak256(raw), raw }
    save()
  }
  let receipt = await pc.getTransactionReceipt({ hash: saved.hash }).catch(() => null)
  if (!receipt) {
    await pc.sendRawTransaction({ serializedTransaction: saved.raw }).catch(() => undefined)
    receipt = await pc.waitForTransactionReceipt({ hash: saved.hash, confirmations: 2, timeout: 120000 })
  }
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`${plan.name} deployment reverted: ${saved.hash}. Inspect the journal; do not retry with a new nonce automatically.`)
  saved.address = receipt.contractAddress
  save()
  // Compare the complete runtime, masking only compiler-declared immutable slots.
  const code = await pc.getCode({ address: saved.address })
  const normalize = hex => {
    const bytes = Buffer.from(hex.slice(2), 'hex')
    for (const refs of Object.values(plan.artifact.deployedBytecode.immutableReferences)) for (const { start, length } of refs) bytes.fill(0, start, start + length)
    return bytes.toString('hex')
  }
  if (!code || normalize(code) !== normalize(plan.artifact.deployedBytecode.object)) throw new Error(`${plan.name} deployed runtime does not match the reviewed artifact.`)
  const getters = plan.name === 'JaraClaimerFactory' ? { ubi, gd: token } : { gd: token, operator, recipient: operator }
  for (const [functionName, expected] of Object.entries(getters)) {
    const actual = await pc.readContract({ address: saved.address, abi: plan.artifact.abi, functionName })
    if (getAddress(actual) !== getAddress(expected)) throw new Error(`${plan.name}.${functionName} mismatch`)
  }
  console.log(`${plan.env}=${saved.address}`)
  console.log(`${plan.name} verified; transaction ${saved.hash}`)
}
// Configuration is intentionally not edited: publish only after both verified addresses exist.
