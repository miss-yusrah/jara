/* eslint-disable @typescript-eslint/no-require-imports */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { ApiError, readApiResponse, responseMessage } = require('../src/lib/api-response.ts')
const { readChatEvents } = require('../src/lib/chat-response.ts')
const { clientRequest } = require('../src/lib/client-request.ts')
const collect = async (response) => { const out = []; for await (const event of readChatEvents(response)) out.push(event); return out }
const stream = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/x-ndjson' } })
const done = { t: 'done', messageId: 42, costGd: 300 }
const retryable = (err) => err instanceof ApiError && err.retryable && !/SyntaxError|Unexpected|JSON|<html>/.test(err.message)

test('AI reads JSON and UTF-8 split across arbitrary network chunks, including a final line without newline', async () => {
  const expected = [{ t: 'chat', chatId: 'chat-1' }, { t: 'delta', v: 'Hello ₦ 👋' }, done]
  const bytes = new TextEncoder().encode(expected.map((e) => JSON.stringify(e)).join('\n'))
  let i = 0
  const body = new ReadableStream({ pull(controller) { if (i < bytes.length) controller.enqueue(bytes.slice(i, ++i)); else controller.close() } })
  assert.deepEqual(await collect(stream(body)), expected)
})

test('HTML, truncated JSON, invalid events, and EOF before confirmation all retain a retryable outcome', async () => {
  for (const body of ['<html>Bad gateway</html>', '{"t":"delta",', 'null\n', '{"t":"done"}\n', '{"t":"done","messageId":42,"costGd":-1}\n', '{"t":"delta","v":"partial"}\n', '']) {
    await assert.rejects(collect(stream(body)), retryable)
  }
  await assert.rejects(collect(new Response('<html>Bad gateway</html>', { status: 502 })), retryable)
  await assert.rejects(collect(new Response('{}', { headers: { 'content-type': 'application/json' } })), retryable)
})

test('a valid confirmation remains final even if garbage or a disconnect follows it', async () => {
  assert.deepEqual(await collect(stream(JSON.stringify(done) + '\n<html>connection ended')), [done])
  let emitted = false
  const body = new ReadableStream({ pull(controller) {
    if (!emitted) { emitted = true; controller.enqueue(new TextEncoder().encode(JSON.stringify(done) + '\n')) }
    else controller.error(new TypeError('NetworkError'))
  } })
  assert.deepEqual(await collect(stream(body)), [done])
})

test('streamed parser errors become readable messages and preserve terminal payment outcomes', async () => {
  const events = await collect(stream(JSON.stringify({ t: 'error', message: 'Unexpected token < in JSON at position 0', terminal: true }) + '\n'))
  assert.equal(events[0].terminal, true)
  assert.doesNotMatch(events[0].message, /JSON|Unexpected/)
  assert.equal(responseMessage('Your AI jar needs G$ 200.'), 'Your AI jar needs G$ 200.')
  assert.match(responseMessage(new TypeError('Failed to fetch')), /connection/i)
})

test('exam terminal metadata survives the shared response reader; unknown outcomes never become terminal', async () => {
  await assert.rejects(readApiResponse(Response.json({ error: 'Confirmed failure.', terminal: true }, { status: 400 })), (err) => err.terminal === true && err.message === 'Confirmed failure.')
  await assert.rejects(readApiResponse(new Response('{"error":', { status: 502 })), (err) => retryable(err) && !err.terminal)
  await assert.rejects(readApiResponse(Response.json({ error: 'Unexpected end of JSON input' }, { status: 500 })), retryable)
})

test('an interrupted AI stream keeps the original purchase ID until a validated confirmation', async () => {
  const input = { text: 'Explain cells', tool: 'research', chatId: null }
  const first = clientRequest('json-test', input)
  await assert.rejects(collect(stream('{"t":"delta","v":"Partial"}\n')), retryable)
  const retry = clientRequest('json-test', input)
  assert.equal(retry.id, first.id)
  for await (const ev of readChatEvents(stream(JSON.stringify(done) + '\n'))) if (ev.t === 'done') retry.finish()
  assert.notEqual(clientRequest('json-test', input).id, first.id)
})

test('AI and exam endpoints return safe JSON even when session storage fails before the handler work', async () => {
  const session = require('../src/lib/session.ts')
  const original = session.requireUser
  session.requireUser = async () => { throw new SyntaxError('Unexpected end of JSON input with private details') }
  try {
    const routes = [
      ['ai/chat', 'POST'], ['ai/chats', 'GET'], ['ai/chats/[id]', 'GET'], ['ai/chats/[id]', 'DELETE'],
      ['exams', 'GET'], ['exams', 'POST'], ['exams/[id]', 'GET'], ['exams/[id]', 'PUT'],
    ]
    for (const [path, method] of routes) {
      const response = await require(`../src/app/api/${path}/route.ts`)[method](new Request('http://localhost/api/test', { method }), { params: Promise.resolve({ id: '1' }) })
      assert.equal(response.status, 503)
      const body = await response.json()
      assert.equal(body.retryable, true)
      assert.doesNotMatch(body.error, /JSON|Unexpected|private/)
    }
  } finally { session.requireUser = original }
})

test('malformed AI and exam input gets a validation message instead of a raw parser error', async () => {
  const session = require('../src/lib/session.ts')
  const original = session.requireUser
  session.requireUser = async () => ({ id: 'json-input-test', connected: true })
  try {
    for (const [path, method] of [['ai/chat', 'POST'], ['exams', 'POST'], ['exams/[id]', 'PUT']]) {
      for (const payload of ['{', 'null']) {
        const response = await require(`../src/app/api/${path}/route.ts`)[method](new Request('http://localhost/api/test', { method, body: payload }), { params: Promise.resolve({ id: '1' }) })
        assert.equal(response.status, 400)
        assert.doesNotMatch((await response.json()).error, /JSON|Unexpected|SyntaxError/)
      }
    }
  } finally { session.requireUser = original }
})

test('a new AI chat accepts the null chat ID sent by the browser', async () => {
  const session = require('../src/lib/session.ts')
  const chat = require('../src/lib/ai-chat.ts')
  const original = { requireUser: session.requireUser, sendChat: chat.sendChat }
  session.requireUser = async () => ({ id: 'json-new-chat', connected: true })
  chat.sendChat = async function* (_user, input) {
    assert.equal(input.chatId, undefined)
    yield done
  }
  try {
    const response = await require('../src/app/api/ai/chat/route.ts').POST(new Request('http://localhost/api/ai/chat', { method: 'POST', body: JSON.stringify({ requestId: 'new-chat-request', chatId: null, tool: 'research', text: 'Explain cells' }) }))
    assert.equal(response.status, 200)
    assert.deepEqual(await collect(response), [done])
  } finally { Object.assign(session, { requireUser: original.requireUser }); chat.sendChat = original.sendChat }
})
