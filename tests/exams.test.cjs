/* eslint-disable @typescript-eslint/no-require-imports */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const { parseEther } = require('viem')
const directory = mkdtempSync(`${tmpdir()}/jara-exams-`)
Object.assign(process.env, { DATABASE_URL: `file:${directory}/test.db`, CHAIN_MODE: 'mock', TOPUP_PROVIDER: 'mock', GD_NGN_RATE: '1', TREASURY_PRIVATE_KEY: `0x${'1'.repeat(64)}` })
const { db, run } = require('../src/lib/db.ts')
const users = require('../src/lib/users.ts')
const chain = require('../src/lib/chain.ts')
chain.balanceBlock = async () => undefined
const llm = require('../src/lib/agent/llm.ts')
llm.llmReachable = async () => true
const { createExam, getExamSession, saveExamSession, listExamSessions } = require('../src/lib/exams.ts')
const { validateQuestions, readExamPaper } = require('../src/lib/exam-paper.ts')
const { generateExamPaper } = require('../src/lib/exam-generator.ts')
const { examDrill, getJobs, saveJobs } = require('../src/lib/agent/jobs.ts')
const questions = Array.from({ length: 20 }, (_, i) => ({ prompt: `What is ${i + 1} plus 1?`, options: [`${i + 2}`, `${i + 3}`, `${i + 4}`, `${i + 5}`], correctOption: 0, explanation: `Adding one to ${i + 1} gives ${i + 2}.`, topic: 'Addition' }))
function validLLM(messages) {
  const batch = Number(messages[1].content.match(/batch (\d) of/)[1])
  return { role: 'assistant', content: JSON.stringify({ questions: questions.slice((batch - 1) * 5, batch * 5) }) }
}
async function fixture() {
  let user = await users.createUser()
  await users.updateUser(user.id, { connected: true, rootAddress: `0x${createHash('sha256').update(user.id).digest('hex').slice(0, 40)}` })
  user = await users.getUserById(user.id)
  await chain.mockDeposit(user.agentAddress, parseEther('1000'))
  await run('UPDATE jars SET target_ngn = 0 WHERE user_id = ?', [user.id])
  await run("UPDATE jars SET balance_wei = ? WHERE user_id = ? AND kind = 'ai'", [String(parseEther('1000')), user.id])
  return user
}

test('only complete papers with four distinct options and valid answer keys are accepted', () => {
  assert.throws(() => validateQuestions(questions.slice(0, 1), 20), /complete set/)
  assert.throws(() => validateQuestions([{ ...questions[0], correctOption: 4 }], 1), /valid answer/)
  assert.throws(() => validateQuestions([{ ...questions[0], options: ['one', 'one', 'two', 'three'] }], 1), /distinct/)
  assert.throws(() => validateQuestions([questions[0], questions[0]], 2), /distinct/)
  assert.equal(validateQuestions([{ ...questions[0], options: ['-1', '1', '-2', '2'] }], 1).length, 1)
  assert.equal(readExamPaper('An old Markdown drill'), null)
})

test('generation retries truncated batches and assembles all 20 questions', async () => {
  const calls = new Map()
  llm.chat = async (messages) => {
    const batch = messages[1].content.match(/batch (\d) of/)[1]
    calls.set(batch, (calls.get(batch) || 0) + 1)
    return calls.get(batch) === 1 ? { content: '{"questions":[]}' } : validLLM(messages)
  }
  const paper = readExamPaper(await generateExamPaper('JAMB Maths'))
  assert.equal(paper.questions.length, 20)
  assert.deepEqual([...calls.values()], [2, 2, 2, 2])
})

test('an incomplete generated paper never charges the AI jar', async () => {
  const user = await fixture()
  llm.chat = async () => ({ content: JSON.stringify({ questions: [questions[0]] }) })
  await assert.rejects(createExam(user, 'JAMB Maths', 'invalid-paper'), /No payment/)
  assert.equal(await chain.gdBalance(user.agentAddress), parseEther('1000'))
  assert.equal((await run('SELECT COUNT(*) AS n FROM ai_runs WHERE user_id = ?', [user.id])).rows[0].n, 0)
  assert.equal((await run('SELECT COUNT(*) AS n FROM payments WHERE user_id = ?', [user.id])).rows[0].n, 0)
})

test('practice purchase retries once; answers persist, grading is private and retakes are free', async () => {
  const user = await fixture()
  llm.chat = async (messages) => validLLM(messages)
  const bought = await createExam(user, 'JAMB Maths', 'complete-paper')
  assert.deepEqual(await createExam(user, 'JAMB Maths', 'complete-paper'), bought)
  assert.equal(await chain.gdBalance(user.agentAddress), parseEther('800'))
  let session = await getExamSession(user.id, bought.id)
  assert.equal(session.questions.length, 20)
  assert.equal(session.score, null)
  assert.equal(session.review, null)
  assert.equal('correctOption' in session.questions[0], false)
  assert.equal('explanation' in session.questions[0], false)
  const other = await fixture()
  await assert.rejects(getExamSession(other.id, bought.id), /not found/)
  await assert.rejects(saveExamSession(other.id, bought.id, { revision: 0, answers: Array(20).fill(0), currentQuestion: 0 }), /not found/)
  const partial = [...session.answers]; partial[0] = 2
  const update = { revision: 0, answers: partial, currentQuestion: 1 }
  session = await saveExamSession(user.id, bought.id, update)
  assert.deepEqual(await saveExamSession(user.id, bought.id, update), session)
  assert.equal((await getExamSession(user.id, bought.id)).answers[0], 2)
  assert.equal(session.currentQuestion, 1)
  await assert.rejects(saveExamSession(user.id, bought.id, { ...update, currentQuestion: 2 }), /another tab/)
  await assert.rejects(saveExamSession(user.id, bought.id, { ...update, revision: session.revision, submit: true }), /every question/)
  const answers = Array(20).fill(0); answers[0] = 2
  session = await saveExamSession(user.id, bought.id, { revision: session.revision, answers, currentQuestion: 19, submit: true, score: 20 })
  assert.equal(session.score, 19)
  assert.equal(session.review.length, 20)
  assert.equal(session.submitted, true)
  await assert.rejects(saveExamSession(user.id, bought.id, { revision: session.revision, answers, currentQuestion: 19 }), /already finished/)
  const history = await listExamSessions(user.id)
  assert.equal(history[0].answered, 20)
  assert.equal(history[0].submitted, true)
  session = await saveExamSession(user.id, bought.id, { revision: session.revision, restart: true })
  assert.equal(session.score, null)
  assert.equal(session.review, null)
  assert.deepEqual(session.answers, Array(20).fill(null))
  assert.equal(session.currentQuestion, 0)
  assert.equal(await chain.gdBalance(user.agentAddress), parseEther('800'))
  assert.equal((await listExamSessions(user.id)).length, 1)
})

test('daily prep sends an accessible full paper at the existing daily price', async () => {
  const user = await fixture()
  llm.chat = async (messages) => validLLM(messages)
  const tomorrow = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10)
  await saveJobs(user.id, { examOn: true, exam: 'JAMB', examDate: tomorrow, examSubjects: ['Maths'] })
  const notice = await examDrill(user, await getJobs(user.id))
  assert.match(notice.message, /20-question/)
  assert.match(notice.message, /G\$ 50/)
  const id = Number(notice.message.match(/run=(\d+)/)[1])
  assert.equal((await getExamSession(user.id, id)).questions.length, 20)
  assert.equal(await examDrill(user, await getJobs(user.id)), null)
  assert.equal(await chain.gdBalance(user.agentAddress), parseEther('950'))
})

after(async () => { (await db()).close(); rmSync(directory, { recursive: true, force: true }) })
