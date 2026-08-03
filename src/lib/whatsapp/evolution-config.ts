import { decrypt } from '@/lib/whatsapp/encryption'
import type { createClient } from '@/lib/supabase/server'

/**
 * Shared plumbing for the Evolution instance routes: env reading,
 * account resolution and row -> connection-triple loading. Kept out of
 * the route files because Next route modules may only export HTTP
 * method handlers.
 */

export interface EvolutionEnv {
  baseUrl: string
  globalApikey: string
  webhookSecret: string
}

export function readEvolutionEnv(): EvolutionEnv | null {
  const baseUrl = process.env.EVOLUTION_BASE_URL
  const globalApikey = process.env.EVOLUTION_GLOBAL_APIKEY
  const webhookSecret = process.env.EVOLUTION_WEBHOOK_SECRET
  if (!baseUrl || !globalApikey || !webhookSecret) return null
  return { baseUrl, globalApikey, webhookSecret }
}

type SessionClient = Awaited<ReturnType<typeof createClient>>

export async function resolveAccountId(
  supabase: SessionClient,
  userId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

export type LoadInstanceResult =
  | {
      ok: true
      row: Record<string, unknown>
      conn: { baseUrl: string; instanceName: string; apikey: string }
    }
  | { ok: false; status: number; error: string }

/**
 * Load one of the caller's Evolution rows (RLS scopes visibility) and
 * decrypt the stored apikey. Falls back to the global key if the stored
 * value is unreadable (e.g. ENCRYPTION_KEY was rotated).
 */
export async function loadInstanceConn(
  supabase: SessionClient,
  id: string
): Promise<LoadInstanceResult> {
  const { data: row, error } = await supabase
    .from('whatsapp_config')
    .select('*')
    .eq('id', id)
    .eq('engine', 'evolution')
    .maybeSingle()
  if (error) return { ok: false, status: 500, error: error.message }
  if (!row) return { ok: false, status: 404, error: 'Instance not found' }

  const baseUrl = (row.evolution_base_url as string) || process.env.EVOLUTION_BASE_URL
  const instanceName = row.evolution_instance_name as string
  if (!baseUrl || !instanceName) {
    return { ok: false, status: 500, error: 'Instance row is missing Evolution fields' }
  }

  let apikey: string
  try {
    apikey = decrypt(row.evolution_apikey as string)
  } catch {
    const fallback = process.env.EVOLUTION_GLOBAL_APIKEY
    if (!fallback) {
      return { ok: false, status: 500, error: 'Stored apikey is unreadable' }
    }
    apikey = fallback
  }

  return { ok: true, row, conn: { baseUrl, instanceName, apikey } }
}
