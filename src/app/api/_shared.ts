import { NextResponse } from 'next/server'
import { listMessages } from '@/lib/agent'
import { llmReachable } from '@/lib/agent/llm'
import { serverConfig } from '@/lib/env'
import { snapshot } from '@/lib/jars'
import { botLink } from '@/lib/telegram'
import { AI_TOOLS, listAiRuns } from '@/lib/ai-tools'
import { rewardProgress } from '@/lib/rewards'
import { listActivity, type User, ensureRefCode } from '@/lib/users'

export async function userState(user: User) {
  const cfg = serverConfig()
  const [snap, activity, messages, llmUp, aiRuns, rewards] = await Promise.all([
    snapshot(user),
    listActivity(user.id, 30),
    listMessages(user.id),
    llmReachable(),
    listAiRuns(user.id, 8),
    rewardProgress(user),
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
      lastRunAt: user.lastRunAt,
      inviteLink: `${cfg.appUrl}/app?ref=${await ensureRefCode(user)}`,
    },
    aiRuns,
    aiTools: Object.entries(AI_TOOLS).map(([id, t]) => ({ id, name: t.name, blurb: t.blurb, priceGd: t.priceGd, placeholder: t.placeholder })),
    rewards,
    snapshot: snap,
    activity,
    messages,
    config: {
      chainMode: cfg.chain.mode,
      provider: cfg.provider,
      billsLive: cfg.billsLive,
      llm: !llmUp ? 'rules' : cfg.llm.baseUrl.includes(':8377') ? 'antseed' : 'llm',
    },
  }
}

export function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}
