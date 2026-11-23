/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const { fvReturn } = require('@/lib/fv-return')

// Exactly how goodid.gooddollar.org builds the return URL (redirectTo + encodeBase64Params).
const enc = (v) => encodeURIComponent(btoa(typeof v === 'string' ? v : JSON.stringify(v)))
function back(rdu, params) {
  const url = new URL(rdu)
  for (const [k, v] of Object.entries(params)) url.searchParams.append(k, enc(v))
  return new URL(url.toString()).searchParams
}
const rdu = 'https://jara.test/app?fv=renew'

test('not a face-check return', () => {
  assert.equal(fvReturn(new URLSearchParams('tab=vote')), null)
})

test('a passed renewal and a passed first check', () => {
  const r = fvReturn(back(rdu, { verified: true, chain: 42220 }))
  assert.equal(r.ok, true)
  assert.match(r.message, /passed/)
  assert.match(fvReturn(back('https://jara.test/app?fv=1', { verified: true })).message, /Connect the same wallet/)
})

test('each failure GoodDollar reports gets its own explanation', () => {
  const cases = [['NotMatchError', /first verification/], ['DuplicateFoundError', /different wallet/], ['NotAllowedError', /camera/i], ['NotSupportedError', /Safari/], ['closed', /wasn’t finished/]]
  for (const [reason, expected] of cases) {
    const r = fvReturn(back(rdu, { verified: false, reason }))
    assert.equal(r.ok, false, reason)
    assert.match(r.message, expected, reason)
  }
})
