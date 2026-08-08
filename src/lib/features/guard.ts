/**
 * Guarda de recursos para os motores do servidor (049).
 *
 * Todo automatismo pergunta aqui antes de agir. Cache curto em memória
 * porque as filas rodam a cada 15s e não faz sentido bater no banco
 * toda vez — 30s de defasagem no pior caso, o que é aceitável para um
 * interruptor (e o realtime já atualiza a UI na hora).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  isEnabled,
  isManualMode,
  toFeatureState,
  type FeatureKey,
  type FeatureState,
} from './catalog'

const CACHE_TTL_MS = 30_000

const cache = new Map<string, { state: FeatureState; at: number }>()

/** Estado dos recursos da conta (com cache). Nunca lança. */
export async function loadFeatureState(
  db: SupabaseClient,
  accountId: string,
): Promise<FeatureState> {
  const hit = cache.get(accountId)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.state

  try {
    const { data } = await db
      .from('account_features')
      .select('feature, enabled')
      .eq('account_id', accountId)
    const state = toFeatureState(data)
    cache.set(accountId, { state, at: Date.now() })
    return state
  } catch (err) {
    console.error('[features] leitura falhou, assumindo tudo ligado:', err)
    // Falha de leitura NÃO pode desligar a operação — padrão é ligado.
    return {}
  }
}

/** "Posso rodar?" — a pergunta que todo motor faz antes de agir. */
export async function featureEnabled(
  db: SupabaseClient,
  accountId: string,
  feature: FeatureKey,
): Promise<boolean> {
  return isEnabled(await loadFeatureState(db, accountId), feature)
}

/** Modo manual ligado nesta conta? */
export async function manualModeOn(
  db: SupabaseClient,
  accountId: string,
): Promise<boolean> {
  return isManualMode(await loadFeatureState(db, accountId))
}

/** Chamado após uma troca de interruptor para não esperar o TTL. */
export function invalidateFeatureCache(accountId?: string): void {
  if (accountId) cache.delete(accountId)
  else cache.clear()
}
