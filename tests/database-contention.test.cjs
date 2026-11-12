/* eslint-disable @typescript-eslint/no-require-imports */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const Database = require('libsql')
const directory = mkdtempSync(`${tmpdir()}/jara-contention-`)
Object.assign(process.env, { DATABASE_URL: `file:${directory}/test.db`, CHAIN_MODE: 'mock' })
const { db, run, atomic } = require('../src/lib/db.ts')
const { withMoneyLock } = require('../src/lib/money-lock.ts')
let blocker

async function holdLock(ms) {
  await db()
  blocker ??= new Database(`${directory}/test.db`)
  blocker.exec('BEGIN EXCLUSIVE')
  return setTimeout(() => blocker.exec('ROLLBACK'), ms)
}

test('reads and standalone writes recover from a separate connection holding the database', async () => {
  await run('CREATE TABLE contention_test (id TEXT PRIMARY KEY, value INTEGER)')
  await holdLock(120)
  const [read] = await Promise.all([
    run('SELECT COUNT(*) AS n FROM contention_test'),
    run("INSERT INTO contention_test VALUES ('once', 1)"),
  ])
  assert.ok(read.rows.length)
  assert.equal((await run('SELECT SUM(value) AS n FROM contention_test')).rows[0].n, 1)
})

test('waiting for a writer starts the transaction callback exactly once', async () => {
  await holdLock(120)
  let calls = 0
  await atomic(async (tx) => {
    calls++
    await tx.execute("UPDATE contention_test SET value = value + 1 WHERE id = 'once'")
  })
  assert.equal(calls, 1)
  assert.equal((await run("SELECT value FROM contention_test WHERE id = 'once'")).rows[0].value, 2)
})

test('money-lock acquisition waits for database contention and releases its lease', async () => {
  await holdLock(120)
  let calls = 0
  await withMoneyLock('contention-user', async () => {
    calls++
    await run("UPDATE contention_test SET value = value + 1 WHERE id = 'once'")
  })
  assert.equal(calls, 1)
  assert.equal((await run("SELECT COUNT(*) AS n FROM money_locks WHERE id = 'contention-user'")).rows[0].n, 0)
})

test('transaction callbacks are never replayed, even if they throw a busy error', async () => {
  let calls = 0
  await assert.rejects(atomic(async (tx) => {
    calls++
    await tx.execute("UPDATE contention_test SET value = 99 WHERE id = 'once'")
    throw Object.assign(new Error('Busy inside business logic'), { code: 'SQLITE_BUSY' })
  }), /Busy inside business logic/)
  assert.equal(calls, 1)
  assert.equal((await run("SELECT value FROM contention_test WHERE id = 'once'")).rows[0].value, 3)
})

test('persistent contention fails within a bounded time and writes nothing', async () => {
  await db()
  blocker.exec('BEGIN EXCLUSIVE')
  const started = Date.now()
  try {
    await assert.rejects(run("INSERT INTO contention_test VALUES ('blocked', 1)"), { code: 'SQLITE_BUSY' })
    assert.ok(Date.now() - started < 3_000)
  } finally { blocker.exec('ROLLBACK') }
  assert.equal((await run("SELECT COUNT(*) AS n FROM contention_test WHERE id = 'blocked'")).rows[0].n, 0)
  await atomic((tx) => tx.execute("INSERT INTO contention_test VALUES ('after-contention', 1)"))
})

test('different accounts can write concurrently without leaking or sharing transactions', async () => {
  await run("INSERT INTO contention_test VALUES ('parallel', 0)")
  await Promise.all(Array.from({ length: 12 }, (_, i) => withMoneyLock(`parallel:${i}`, async () => {
    await run("UPDATE contention_test SET value = value + 1 WHERE id = 'parallel'")
  })))
  assert.equal((await run("SELECT value FROM contention_test WHERE id = 'parallel'")).rows[0].value, 12)
  assert.equal((await run('SELECT COUNT(*) AS n FROM money_locks')).rows[0].n, 0)
})

after(async () => {
  blocker?.close()
  ;(await db()).close()
  rmSync(directory, { recursive: true, force: true })
})
