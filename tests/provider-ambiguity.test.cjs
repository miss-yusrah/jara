/* eslint-disable @typescript-eslint/no-require-imports */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { FalconPayProvider } = require('../src/lib/providers/falconpay.ts')
process.env.FALCONPAY_API_KEY = 'sk_test_regression'
const originalFetch = global.fetch
let response = { status: 200, json: {} }
global.fetch = async url => {
  const path = new URL(url).pathname
  if (path.endsWith('/services')) return Response.json({ data: [{ service_id: 'mtn', name: 'MTN' }] })
  if (path.endsWith('/quote')) return Response.json({ data: { quote_token: 'test-quote', quote_exp: 9999999999, face_amount: 100, amount_to_be_debited: 100 } })
  return Response.json(response.json, { status: response.status })
}
const provider = new FalconPayProvider()
const reference = 'JARA-regression-reference'
const buy = () => provider.buyAirtime({ network: 'mtn', phone: '08031234567', amount: 100, reference })

test('unsettled provider responses cannot complete a purchase or trigger a refund', async () => {
  for (const status of ['failed', 'refunded', 'successful']) {
    response = { status: 200, json: { data: { status, settled: false, reference } } }
    assert.equal((await buy()).state, 'pending', `purchase ${status} with settled:false`)
    assert.equal((await provider.getStatus(reference)).state, 'pending', `status ${status} with settled:false`)
  }
})

test('HTTP failures after submission are ambiguous without a final provider outcome', async () => {
  for (const status of [400, 401, 403, 422, 503]) {
    response = { status, json: { message: 'Upstream error' } }
    assert.equal((await buy()).state, 'pending', `HTTP ${status} alone must not refund`)
  }
  response = { status: 422, json: { data: { status: 'failed', settled: false, reference } } }
  assert.equal((await buy()).state, 'pending')
  response = { status: 422, json: { data: { status: 'refunded', settled: true, reference } } }
  assert.equal((await buy()).state, 'failed')
  response = { status: 200, json: { data: { status: 'successful', settled: true, reference } } }
  assert.equal((await buy()).state, 'success')
})

test('a response for another provider reference cannot settle this purchase', async () => {
  for (const status of ['failed', 'successful']) {
    response = { status: 200, json: { data: { status, settled: true, reference: 'different-order' } } }
    assert.equal((await buy()).state, 'pending')
    assert.equal((await provider.getStatus(reference)).state, 'pending')
  }
})

after(() => { global.fetch = originalFetch })
