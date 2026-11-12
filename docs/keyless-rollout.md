# Keyless claims and bounded spending rollout

Deployed to [usejara.xyz](https://usejara.xyz) on November 12, 2026. Both Celo contracts have source verification with an exact match. At deployment, five connected users still needed to approve their upgrade; no existing owner was migrated by the deployer. See the [deployment record](deployment-2026-11-12.md) for addresses, receipts, production configuration and checks.

## Contracts and app behavior

- [`JaraClaimer`](../contracts/src/JaraClaimer.sol): one immutable contract per owner, deployed by a deterministic factory. Anyone can pay gas to claim; every G$ goes to its owner. The owner can revoke the identity link and rescue stray tokens directly. There is no operator role, private key or upgrade mechanism.
- [`JaraSpending`](../contracts/src/JaraSpending.sol): owner-configured total budget, UTC-day cap and expiry. Only the fixed operator can charge, and funds go only to the fixed recipient. Payment IDs cannot replay. Limits apply even when the server is compromised. Today's consumed budget survives policy changes.
- [`claimers.ts`](../src/lib/claimers.ts): preparation, owner signature verification, identity/allowance revocation checks, deployment, activation and durable daily claims. New users have no agent key. Existing users retain old recovery keys and balances, which remain exposed until moved.
- [`onboard/route.ts`](../src/app/api/onboard/route.ts) and [`AppClient.tsx`](../src/components/AppClient.tsx): new onboarding and Profile → Upgrade daily claims. A fresh root signature binds the public deterministic contract to the intended Jara account. An on-chain link alone is insufficient authentication.
- [`chain.ts`](../src/lib/chain.ts), [`spend.ts`](../src/lib/spend.ts): upgraded users can spend only through the policy contract. Missing policy configuration means zero spending availability, with no direct-allowance fallback. New keyless claims are sponsored without adding gas debt.

## Before production

1. Review the contract source and constructor values. These tests are not an independent contract audit. Publish verified source for the deployed addresses so owners can inspect their immutable permissions.
2. Back up the application database and retain recovery keys. Do not delete old wallet keys or chain/payment journals. Pause old workers during deployment; all workers must run the new schema-aware code.
3. Confirm the live money mode from the existing authenticated admin report, `GET /api/admin/treasury?custody=1`. Its `money` object reports the resolved mode without revealing credentials. The November 12 deployment confirmed real Celo funds with live FalconPay, demo bills disabled, and no mixed-mode configuration.
4. Choose the Celo treasury/operator address and a funded deployer. The spending contract fixes operator and recipient at deployment. Key rotation requires another spending contract and renewed owner permissions; it is not a silent environment change. Keep only operational funds in the treasury: its own private key is still server-accessible.

## Build, plan and deploy

From the repository root:

```sh
forge build --root contracts --evm-version paris
node --env-file=.env.production.local scripts/deploy-custody.mjs
```

The second command is a **read-only plan**: chain ID, public addresses, constructor arguments, creation hashes and estimated gas. It never signs. The script does not load an environment file implicitly. For a plan without any private keys, set `TREASURY_ADDRESS` and optionally `CUSTODY_DEPLOYER_ADDRESS` instead.

Once the plan has been reviewed and production deployment is authorized:

```sh
node --env-file=.env.production.local scripts/deploy-custody.mjs --broadcast
```

The deployer key is `CUSTODY_DEPLOYER_PRIVATE_KEY`, or `TREASURY_PRIVATE_KEY` when no separate deployer is supplied. Do not paste keys into a command line. Both chain ID and constructor configuration are checked. The script verifies deployed runtime bytecode (masking only declared immutable slots), then checks the immutable addresses.

The default journal is `output/custody-deployment.json`, or `CUSTODY_DEPLOY_JOURNAL`. Preserve it across retries. Signed transaction bytes and hashes are saved before broadcast. Re-running resumes the same transactions; it does not redeploy with new nonces. A reverted transaction requires investigation. Run only one deployment process at a time. The script prints verified environment assignments and **does not edit** the application's environment or deploy the application.

Set the two verified addresses in the production environment:

```dotenv
CLAIMER_FACTORY_ADDRESS=<verified factory address>
SPENDING_CONTRACT_ADDRESS=<verified spending contract address>
```

Keep the legacy `WALLET_*` provider configuration while old wallets need recovery. Then deploy the app using the established deployment process. The November 12 production addresses are in the deployment record; preserve the existing deployment journal instead of deploying duplicate contracts.

## Migration and checks

- New signups prepare a contract address without creating an agent key. The owner links it, signs the account-bound activation message, and Jara sponsors deployment. Verify the first claim's receipt and that the owner's G$ balance increases while the contract retains no G$.
- Existing users upgrade in Profile. Wallet transactions revoke the old treasury allowance, disconnect the old agent and connect the new contract. A fresh signature completes activation. A stopped migration may pause claims; the upgrade button resumes safely. Transactions must settle before activation.
- Activation refuses a still-linked legacy agent or a nonzero old treasury allowance. Verify both independently on Celo for an initial pilot user.
- After upgrading, withdraw old claimed funds using the recovery button, and export the old key if needed to recover CELO. These keys remain stored for recovery; migration itself does not erase old ciphertext or backups. Once the old wallet is unlinked and empty, an operator deletes its stored key through the admin report (`?custody=retire`, then `{"retireKeys": true}`); see the README.
- Spending requires **separate** wallet approval and policy configuration. The UI offers G$ 5,000 total, G$ 1,000 per UTC day, expiring after 30 days. Revoking spending keeps claims running. Policies cannot be increased by the assistant or server. The safety follow-up pauses pre-existing auto-pay and paid jobs once; owners must explicitly enable them again as well as grant the spending policy.
- Jars reflect currently spendable funds. Hitting the daily cap can shrink displayed allocations and defer bills; a bill above G$ 1,000 cannot be paid under the default policy. Refunds do not restore consumed policy budget or ERC-20 allowance. A UTC-day cap can permit two days' budgets around midnight, still bounded by the total.
- The admin custody response includes `keyless.active`, `keyless.awaiting_upgrade`, `keyless.retained_keys`, factory/spending addresses and the resolved money mode. KMS `pending: 0` means key rewrapping is complete; it does **not** mean users have upgraded to keyless claims.

## Recovery and rollback

- Do not roll back to an app binary that ignores `claimer_active`. Removing the factory flag only stops **new** keyless onboarding; migrated accounts keep their persisted claimer.
- Missing spending-contract configuration disables new upgraded spending. It does not revert to treasury allowances. Restore the same address before resuming saved charges; changing it mid-charge must not create another transaction.
- An unavailable sponsor prevents Jara's scheduled claims but does not redirect funds: the owner or anyone else may call the contract's `claim()` directly.
- A compromised server can still consume authorized spending budgets and drain the treasury's own funds. Stop the operator and revoke token/policy approvals. Claim contracts cannot send UBI to a replacement recipient. A malicious frontend can still ask a wallet owner to approve harmful transactions; users must inspect wallet prompts.

## Verification evidence

- Local Solidity tests cover immutable claim destinations, owner-only rescue, deterministic deployment, spending caps/expiry/replay/revocation, transfer failure rollback and a 256-case fuzz test.
- At Celo fork block **82581035**, the combined migration/claim/spending test passed independently with public verified roots `0xf298A1B4f17E9b02EBb024d7755673C94c20Cc06` and `0xcc8972b80D9e561624473881C6666B4973cd43c0`. It links an undeployed address, deploys it, claims to the owner, pays through the policy, rejects spending above the daily cap, and revokes the new link. All transactions existed only inside the local fork.
- The deployment script deployed and verified both contracts on a disposable local Anvil chain. These local addresses must **not** be used as production configuration.
- App regression tests use temporary databases and simulated RPC. They cover signature/account binding, migration prerequisites, no new private keys, no legacy spending fallback, daily-claim recovery, direct owner rewards and pre-migration reward recovery.
- `npm run build -- --webpack` succeeded locally and on the production staging host with optional wallet SDK/dependency warnings. The deployed build uses Webpack after a staging Turbopack CSS-loader failure. No interactive browser-wallet walkthrough has been performed.
- All 112 application tests and lint passed before release. The production migration was tested against a private database snapshot, including a correction to the historical referral backfill query. Live HTTP checks confirmed keyless signup, blocked demo deposits, disabled legacy key/deposit routes for the new account, and admin authorization. The temporary smoke account was removed.

Reproduce the live-fork test without broadcasting:

```sh
cd contracts
GD_ROOT=0xf298A1B4f17E9b02EBb024d7755673C94c20Cc06 forge test \
  --match-contract JaraClaimerForkTest --evm-version cancun \
  --fork-url https://forno.celo.org --fork-block-number 82581035 -vv
```

Rebuild with `--evm-version paris` before a production deployment plan: compiler settings affect deterministic addresses.
