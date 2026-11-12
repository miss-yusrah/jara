import { NextResponse } from 'next/server'
import { listMessages } from '@/lib/agent'
import { llmReachable } from '@/lib/agent/llm'
import { serverConfig } from '@/lib/env'
import { treasuryAddress } from '@/lib/chain'
import { DEFAULT_LIMIT_GD } from '@/lib/spend'
import { snapshot } from '@/lib/jars'
import { botLink } from '@/lib/telegram'
import { AI_TOOLS, listAiRuns } from '@/lib/ai-tools'
import { rewardProgress } from '@/lib/rewards'
import { DRILL_PRICE_GD, EXAMS, SCOUT_PRICE_GD, daysUntil, getJobs, verificationStatus } from '@/lib/agent/jobs'
import { listActivity, type User, ensureRefCode } from '@/lib/users'

export async function userState(user: User) {
  const cfg = serverConfig()
  const [snap, activity, messages, llmUp, aiRuns, rewards, jobs, verification] = await Promise.all([
    snapshot(user),
    listActivity(user.id, 30),
    listMessages(user.id),
    llmReachable(),
    listAiRuns(user.id, 8),
    rewardProgress(user),
    getJobs(user.id),
    verificationStatus(user),
  ])
  return {
    user: {
      id: user.id,
      name: user.name,
      rootAddress: user.rootAddress,
      agentAddress: user.agentAddress,
      connected: user.connected,
      streak: user.streak,
      telegramLinked: Boolean(user.tgChatId),
      telegramLink: botLink(user.linkCode),
      hasPending: Boolean(user.pending),
      pendingId: user.pending?.id ?? null,
      lastRunAt: user.lastRunAt,
      inviteLink: `${cfg.appUrl}/app?ref=${await ensureRefCode(user)}`,
    },
    aiRuns,
    aiTools: Object.entries(AI_TOOLS).map(([id, t]) => ({ id, name: t.name, blurb: t.blurb, priceGd: t.priceGd, placeholder: t.placeholder })),
    rewards,
    jobs: {
      exam: {
        on: jobs.examOn,
        exam: jobs.exam,
        subjects: jobs.examSubjects,
        date: jobs.examDate,
        daysLeft: jobs.examDate ? daysUntil(jobs.examDate) : null,
        drillsDone: jobs.examCount,
        priceGd: DRILL_PRICE_GD,
        options: [...EXAMS],
      },
      scout: { on: jobs.scoutOn, interests: jobs.scoutInterests, lastAt: jobs.scoutLastAt, priceGd: SCOUT_PRICE_GD },
      verification: {
        expiresAt: verification.expiresAt,
        daysLeft: verification.expiresAt ? Math.ceil((verification.expiresAt - Date.now()) / 86_400_000) : null,
      },
    },
    snapshot: snap,
    activity,
    messages,
    config: {
      chainMode: cfg.chain.mode,
      provider: cfg.provider,
      billsLive: cfg.billsLive,
      llm: !llmUp ? 'rules' : cfg.llm.baseUrl.includes(':8377') ? 'antseed' : 'llm',
      // Spender address for the spending limit people approve in their wallet.
      treasury: cfg.chain.mode === 'celo' ? safeTreasury() : null,
      limitGd: DEFAULT_LIMIT_GD,
    },
  }
}

function safeTreasury(): string | null {
  try {
    return treasuryAddress()
  } catch {
    return null
  }
}

export function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}
