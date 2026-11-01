import { serverConfig } from '@/lib/env'
import { MockProvider } from './mock'
import type { TopupProvider } from './types'
import { VTPassProvider } from './vtpass'

// Add ClubKonnectProvider / ReloadlyProvider here.
const factories: Record<string, () => TopupProvider> = {
  vtpass: () => new VTPassProvider(),
  mock: () => new MockProvider(),
}

const instances = new Map<string, TopupProvider>()

export function getProviderByName(name: string): TopupProvider {
  const factory = factories[name]
  if (!factory) throw new Error(`Unknown top-up provider "${name}"`)
  let provider = instances.get(name)
  if (!provider) {
    provider = factory()
    instances.set(name, provider)
  }
  return provider
}

/** The provider new orders are sent to. */
export function getTopupProvider(): TopupProvider {
  return getProviderByName(serverConfig().provider)
}

export type { DataPlan, MeterVerification, TopupProvider, TopupResult, TopupState, TopupStatus } from './types'
