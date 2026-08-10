/**
 * Transcrição de áudio (055) — liga o speechToText nativo da Evolution
 * com a chave da OpenAI do dono (BYO).
 *
 * GET    → { enabled, has_key }        (a chave NUNCA volta ao client)
 * POST   → { api_key }                 valida, criptografa, liga nas instâncias
 * DELETE → desliga nas instâncias e apaga a chave
 *
 * A chave é colada pelo DONO na tela — o mesmo contrato da chave da
 * Anthropic (ai_configs.api_key): AES-256-GCM no banco, nunca em log.
 */

import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { configureSpeechToText } from '@/lib/whatsapp/evolution-api'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { data } = await supabase
      .from('ai_configs')
      .select('transcricao_enabled, transcricao_api_key')
      .eq('account_id', accountId)
      .maybeSingle()
    return NextResponse.json({
      enabled: data?.transcricao_enabled === true,
      has_key: Boolean(data?.transcricao_api_key),
    })
  } catch (err) {
    return guardError(err)
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`transcricao:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) {
      return NextResponse.json({ error: 'Muitas tentativas — aguarde.' }, { status: 429 })
    }

    const body = await request.json().catch(() => ({}))
    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
    if (!rawKey.startsWith('sk-') || rawKey.length < 20) {
      return NextResponse.json(
        { error: 'Chave inválida — uma chave da OpenAI começa com "sk-".' },
        { status: 400 },
      )
    }

    const resultados = await aplicarNasInstancias(supabase, accountId, rawKey, true)
    if (resultados.erros.length > 0 && resultados.ok === 0) {
      // Nenhuma instância aceitou: não guarda a chave, devolve o motivo.
      return NextResponse.json({ error: resultados.erros[0] }, { status: 502 })
    }

    // upsert preserva o resto da linha do ai_configs quando ela já existe.
    const { data: existente } = await supabase
      .from('ai_configs')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle()
    if (existente) {
      await supabase
        .from('ai_configs')
        .update({ transcricao_api_key: encrypt(rawKey), transcricao_enabled: true })
        .eq('account_id', accountId)
    } else {
      await supabase.from('ai_configs').insert({
        account_id: accountId,
        user_id: userId,
        transcricao_api_key: encrypt(rawKey),
        transcricao_enabled: true,
      })
    }

    return NextResponse.json({
      ok: true,
      instancias_ok: resultados.ok,
      avisos: resultados.erros,
    })
  } catch (err) {
    return guardError(err)
  }
}

export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { data } = await supabase
      .from('ai_configs')
      .select('transcricao_api_key')
      .eq('account_id', accountId)
      .maybeSingle()

    let chave = ''
    try {
      chave = data?.transcricao_api_key ? decrypt(data.transcricao_api_key) : ''
    } catch {
      // Chave ilegível: ainda assim desliga nas instâncias e limpa.
    }
    if (chave) await aplicarNasInstancias(supabase, accountId, chave, false)

    await supabase
      .from('ai_configs')
      .update({ transcricao_api_key: null, transcricao_enabled: false })
      .eq('account_id', accountId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return guardError(err)
  }
}

/** Liga/desliga o speechToText em todas as instâncias Evolution da conta. */
async function aplicarNasInstancias(
  supabase: Awaited<ReturnType<typeof requireRole>>['supabase'],
  accountId: string,
  openaiApiKey: string,
  enabled: boolean,
): Promise<{ ok: number; erros: string[] }> {
  const { data: instancias } = await supabase
    .from('whatsapp_config')
    .select('evolution_base_url, evolution_instance_name, evolution_apikey')
    .eq('account_id', accountId)
    .eq('engine', 'evolution')

  let ok = 0
  const erros: string[] = []
  for (const row of instancias ?? []) {
    const baseUrl =
      (row.evolution_base_url as string) || process.env.EVOLUTION_BASE_URL
    const instanceName = row.evolution_instance_name as string
    if (!baseUrl || !instanceName) continue
    let apikey: string
    try {
      apikey = decrypt(row.evolution_apikey as string)
    } catch {
      apikey = process.env.EVOLUTION_GLOBAL_APIKEY ?? ''
    }
    if (!apikey) continue
    const r = await configureSpeechToText({
      baseUrl,
      instanceName,
      apikey,
      openaiApiKey,
      enabled,
    })
    if (r.ok) ok++
    else if (r.error) erros.push(`${instanceName}: ${r.error}`)
  }
  return { ok, erros }
}

function guardError(err: unknown) {
  const msg = err instanceof Error ? err.message : 'Unauthorized'
  const status = msg.includes('Unauthorized') || msg.includes('Forbidden') ? 403 : 500
  return NextResponse.json({ error: msg }, { status })
}
