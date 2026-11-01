import { AppClient } from '@/components/AppClient'

export const dynamic = 'force-dynamic'

export default async function AppPage({ searchParams }: PageProps<'/app'>) {
  const sp = await searchParams
  const tg = typeof sp.tg === 'string' ? sp.tg : undefined
  const ref = typeof sp.ref === 'string' ? sp.ref : undefined
  return <AppClient tgCode={tg} refCode={ref} />
}
