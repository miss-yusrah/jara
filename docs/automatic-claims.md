# Automatic claim recovery

Live claims use GoodDollar's on-chain `periodStart` and latest block timestamp,
not a Lagos calendar date. Empty entitlement checks never update `last_claim_day`.
Only positive confirmed receipts advance the streak. Streak rewards remain limited
to one per Lagos date. Signed transactions from older deployments are recovered
with their original operation IDs before attempting a new claim.

`POST /api/cron/claims` requires the cron bearer secret. It runs the daily claim,
forwarding and enabled auto-pay checks without paid AI jobs or outbound messages.
User locks and a sweep lock prevent concurrent spending. One account's failure
does not stop the other accounts. The normal daily agent schedule remains active.
Pinned balance, allowance and period reads retry bounded `block is out of range`
errors from lagging RPC nodes at the original block. Writes and unrelated failures
are not retried by this helper.

After deploying, run `node scripts/install-claims-cron.mjs` on the server. This
adds an hourly run at minute 5 and preserves existing schedules. The runner loads
the secret from the server environment file and writes aggregate counts to
`data/claims-status.json`. Monitor `checkedAt`, `retries`, and `reconnect`.

`GET /api/claim` is an authenticated, read-only health check. The dashboard and
wallet panel distinguish missing identity verification, a broken claim link,
available G$, no current entitlement, and an unavailable RPC. Network errors do
not imply a broken link or a successful claim.

A broken identity link requires the owner to choose **Reconnect daily claims**
and approve `connectAccount` in their verified GoodDollar wallet. The app checks
the selected wallet against the saved owner before requesting the transaction,
waits for its receipt, and checks the live link again. It never changes the saved
owner or grants spending approval. Expired identities must renew GoodDollar
verification first. Do not bypass these checks or edit the database to simulate
reconnection.
