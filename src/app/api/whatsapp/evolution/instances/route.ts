import { NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { encrypt } from '@/lib/whatsapp/encryption'
import {
  createInstance,
  deleteInstance,
  getConnectionState,
} from '@/lib/whatsapp/evolution-api'
import {
  readEvolutionEnv,
  resolveAccountId,
} from '@/lib/whatsapp/evolution-config'

/**
 * Evolution instance management.
 *
 *   GET  /api/whatsapp/evolution/instances  — list this account's numbers
 *   POST /api/whatsapp/evolution/instances  — register a new number slot
 *
 * One whatsapp_config row per instance (migration 037). Writes go
 * through the caller's session client so the RLS policies (admin-only
 * INSERT/DELETE on whatsapp_config) do the permission check for us.
 *
 * Server-wide Evolution credentials come from env — see
 * src/lib/whatsapp/evolution-config.ts.
 */

export async function GET() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json({ error: 'No account' }, { status: 400 })
    }

    // RLS scopes this to the caller's account.
    const { data: rows, error } = await supabase
      .from('whatsapp_config')
      .select(
        'id, display_name, evolution_instance_name, phone_number, status, is_default, connected_at, created_at'
      )
      .eq('engine', 'evolution')
      .order('created_at', { ascending: true })
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Refresh live connection state (best-effort — a down Evolution
    // server must not break the Settings page).
    const env = readEvolutionEnv()
    const instances = await Promise.all(
      (rows ?? []).map(async (row: Record<string, unknown>) => {
        let liveState: string | null = null
        if (env && row.evolution_instance_name) {
          try {
            liveState = await getConnectionState({
              baseUrl: env.baseUrl,
              instanceName: row.evolution_instance_name as string,
              apikey: env.globalApikey,
            })
          } catch {
            liveState = null
          }
        }
        return { ...row, live_state: liveState }
      })
    )

    return NextResponse.json({ instances })
  } catch (error) {
    console.error('[evolution-instances] GET failed:', error)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json({ error: 'No account' }, { status: 400 })
    }

    const env = readEvolutionEnv()
    if (!env) {
      return NextResponse.json(
        {
          error:
            'Evolution API is not configured. Set EVOLUTION_BASE_URL, EVOLUTION_GLOBAL_APIKEY and EVOLUTION_WEBHOOK_SECRET.',
        },
        { status: 500 }
      )
    }

    let body: { display_name?: string }
    try {
      body = await request.json()
    } catch {
      body = {}
    }
    const displayName = (body.display_name ?? '').trim() || 'WhatsApp'

    // Unique, non-guessable name on the shared Evolution server.
    const instanceName = `crm-${randomBytes(4).toString('hex')}`

    // Webhook target. In production the request origin is the app's
    // public URL; in dev EVOLUTION_WEBHOOK_BASE_URL should point at the
    // tunnel (Evolution cannot reach localhost).
    const origin =
      process.env.EVOLUTION_WEBHOOK_BASE_URL ??
      process.env.NEXT_PUBLIC_SITE_URL ??
      new URL(request.url).origin
    const webhookUrl = `${origin.replace(/\/+$/, '')}/api/whatsapp/evolution/webhook`

    const created = await createInstance({
      baseUrl: env.baseUrl,
      instanceName,
      apikey: env.globalApikey,
      webhookUrl,
      webhookHeaders: { 'x-evolution-secret': env.webhookSecret },
    })

    // Prefer the per-instance token when Evolution hands one back; the
    // global key always works but scoping limits blast radius.
    const apikeyToStore = created.instanceToken || env.globalApikey

    // First instance of the account becomes the default sender.
    const { count: existingCount } = await supabase
      .from('whatsapp_config')
      .select('id', { count: 'exact', head: true })
      .eq('is_default', true)

    // Session client insert → RLS enforces account admin.
    const { data: row, error: insertError } = await supabase
      .from('whatsapp_config')
      .insert({
        account_id: accountId,
        user_id: user.id,
        engine: 'evolution',
        display_name: displayName,
        evolution_base_url: env.baseUrl,
        evolution_instance_name: created.instanceName,
        evolution_apikey: encrypt(apikeyToStore),
        status: 'disconnected',
        is_default: (existingCount ?? 0) === 0,
      })
      .select('id, display_name, evolution_instance_name, status, is_default')
      .single()

    if (insertError) {
      // Roll back the orphan instance on the Evolution server so a
      // failed insert doesn't leak slots.
      try {
        await deleteInstance({
          baseUrl: env.baseUrl,
          instanceName: created.instanceName,
          apikey: env.globalApikey,
        })
      } catch {
        // best-effort cleanup
      }
      const denied = insertError.code === '42501'
      return NextResponse.json(
        { error: denied ? 'Only account admins can add numbers' : insertError.message },
        { status: denied ? 403 : 500 }
      )
    }

    return NextResponse.json({ instance: row, qr_base64: created.qrBase64 ?? null })
  } catch (error) {
    console.error('[evolution-instances] POST failed:', error)
    const message = error instanceof Error ? error.message : 'Internal error'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
