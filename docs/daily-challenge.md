# Daily Jara airtime campaign

Daily Jara is a three-question activity followed by a direct wallet transaction on Celo. A completed quiz qualifies regardless of score. The user reviews the explanations and submits `enter` from their verified GoodDollar root wallet. The contract records `DailyEntry(user, day, challengeId, streak)`, limits entries to one per root per Lagos day, and never moves G$ or requests token approval. Network fees are paid by the participant and disclosed before entry.

The activity streak is independent of automatic claim streaks. Questions rotate weekly from a versioned, reviewed bank; do not change v1 questions during an active campaign. A completion voucher is signed by a dedicated server key and bound to Celo chain ID, contract, wallet, day and challenge ID. A server signature proves that Jara accepted a completion; it does not independently prove a person read an explanation. The wallet must still submit its own transaction. Current GoodDollar verification is checked by the contract at entry time.

## Launch

1. Reserve the full airtime budget outside the contract: five ₦1,000 prizes per day, or ₦70,000 for a 14-day campaign, plus provider costs. The contract does not escrow naira or guarantee delivery.
2. Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` and `forge test --root contracts`. Review the contract; these checks are not an independent audit.
3. Create a dedicated `DAILY_CHALLENGE_SIGNER_KEY` and a separate `DAILY_CHALLENGE_DEPLOYER_KEY`. Do not reuse treasury or user keys. The deployer becomes the immutable owner and needs CELO for deployment. Keep that key offline after deployment; the server needs only the completion signer. The signer requires no token balance or spending allowance.
4. With `CHAIN_MODE=celo`, compile and explicitly deploy. Example dates below are placeholders; use actual future Lagos dates:

   ```sh
   forge build --root contracts
   node --env-file=.env.production.local scripts/deploy-daily-challenge.mjs YYYY-MM-DD YYYY-MM-DD --funded
   ```

5. Save the printed address as `DAILY_CHALLENGE_CONTRACT`, verify the deployed source, and register that exact contract address with GoodDollar's tracker. Confirm that direct, zero-value interactions count toward their season retention definition. The code cannot establish what their dashboard counts.
6. Set `DAILY_CHALLENGE_ENABLED=true` and restart the app. The server checks the contract's identity address, campaign dates and pause state. Keep `ADMIN_KEY` configured. No contract or disabled configuration shows a clearly inactive card; mock mode cannot issue real entry vouchers.
7. Use a verified participant wallet to complete one challenge and confirm that its address is the transaction sender, appears in `DailyEntry`, and is attributed correctly in the season dashboard. Confirm the displayed network fee before sending.

Campaigns are bounded to 1–90 Lagos days. They cannot be extended or have their signer changed. Use a new reviewed deployment for a later campaign. Do not change the configured address while prior prize claims/deliveries remain outstanding: the initial UI and admin panel serve the configured campaign only. Historical chain entries and database draw records remain intact.

## Draw and fulfilment

Open `/admin/challenges` with the existing admin key. After each Lagos midnight, click the closed day's draw button. Do this within 24 hours of closing, as promised by the participant rules.

The server reads the complete entrant list at a finalized block after midnight. This includes users whose browser closed before syncing. It generates a cryptographic random seed, ranks entrants by `keccak256(seed || address)` ascending, and takes up to five different winners. The seed, snapshot block number/hash, entrant list and winners are committed in one database transaction. Concurrent requests and retries return the same saved result. No reroll/delete API is exposed. With fewer than five entrants, each entrant wins ₦1,000; unused prizes do not roll over. With no entrants, an empty draw is recorded.

This is an **operator-run random draw**, not VRF or trustless randomness. Published seeds allow checking the saved result against its snapshot, but cannot prove the operator did not choose randomness before publishing it. Do not market it as provably fair or an on-chain random selection. A future VRF-based draw would require a separate implementation and review.

Winners see a recipient form in Daily Jara. An authenticated session bound to the winning root submits a Nigerian number and network. Those details become immutable once submitted, to avoid delivery to stale destinations. They are visible only to that root and authenticated operators; public draw records contain wallet addresses, never phone numbers. The admin report stores `recipient_at` so the operator can track the promised 48-hour delivery window.

Send **₦1,000 airtime manually** through the provider, then record the successful provider receipt in the admin panel. Recording a receipt does not itself send airtime. Do not route prizes through normal bill purchases: those would charge the user's G$. Reconcile pending provider orders using their original reference rather than resending. Delivery retries with the same receipt are safe; a different receipt cannot overwrite a recorded delivery. Protect and back up this database as you do existing money records.

## Recovery and pauses

- A quiz submission and explanation review are saved by root, contract and day. Wallet cancellation or insufficient gas does not create an entry. The UI preserves the quiz and lets the person retry.
- A submitted transaction hash is saved in browser storage. Retrying waits on that transaction. The contract's `entered` mapping is the source of truth across reloads or devices; duplicate calls cannot create another chance. A dropped/replaced transaction may need wallet-level reconciliation before retrying.
- The day changes at 23:00 UTC, midnight Lagos. A ticket for yesterday cannot enter today. Streaks grow only on confirmed entries, and missing a day preserves previous entries and prizes.
- `DAILY_CHALLENGE_ENABLED=false` stops new vouchers. Already-issued vouchers remain usable until midnight unless the owner calls `setPaused(true)`. Pausing preserves all entries and prizes; continue drawing and fulfilling already-accepted entries.
- The signer cannot enter on behalf of users. A compromised signer can attest false quiz completion; it cannot bypass identity or daily-entry limits, move funds, or fabricate user-sent transactions. Protect it accordingly.

## Metrics and public records

Give GoodDollar the new contract address and ABI. `DailyEntry.user` is the verified root and the transaction sender. `day` is `floor((unixSeconds + 3600) / 86400)`. Query distinct roots by day/week and returning cohorts from these events, separate from automatic claims and G$ transfer volume. Do not publish quiz answers, phone numbers, or claim automatic activity as a human return.

`GET /api/challenges/results?day=<integer>` publishes the configured campaign's saved draw, randomness method, seed, finalized snapshot and winners. Airtime delivery is an off-chain operator attestation, not blockchain proof that the telecom provider delivered a top-up. No new Telegram notifications, automatic airtime spending, deployment, or campaign activation happens merely by merging these files.
