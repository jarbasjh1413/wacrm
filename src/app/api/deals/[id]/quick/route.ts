/**
 * Ajuste rápido do negócio direto da conversa (051).
 * PATCH /api/deals/{id}/quick  body: { value?, stage_id? }
 *
 * O que gente mexe aqui fica TRAVADO para o Radar (`value_locked_at` /
 * `stage_locked_at`): a IA continua cuidando do resto do negócio, mas
 * nunca desfaz uma decisão humana.
 */

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveAccountId } from '@/lib/whatsapp/evolution-config'

export const dynamic = 'force-dynamic'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
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
      return NextResponse.json({ error: 'Sem conta vinculada' }, { status: 400 })
    }

    const body = await request.json().catch(() => ({}))
    const nowIso = new Date().toISOString()
    const patch: Record<string, unknown> = {}

    if (body.value !== undefined) {
      const value = Number(body.value)
      if (!Number.isFinite(value) || value < 0) {
        return NextResponse.json({ error: 'Valor inválido' }, { status: 400 })
      }
      patch.value = value
      patch.value_locked_at = nowIso
    }

    if (typeof body.stage_id === 'string' && body.stage_id) {
      // O estágio precisa ser do funil desta conta — o cliente manda o
      // id e o service role não valida isso sozinho.
      const { data: stage } = await supabase
        .from('pipeline_stages')
        .select('id, pipeline:pipelines!inner(account_id)')
        .eq('id', body.stage_id)
        .maybeSingle()
      const pipelineRaw = (stage as Record<string, unknown> | null)?.pipeline
      const pipeline = Array.isArray(pipelineRaw) ? pipelineRaw[0] : pipelineRaw
      if (!stage || (pipeline as { account_id?: string })?.account_id !== accountId) {
        return NextResponse.json({ error: 'Estágio inválido' }, { status: 400 })
      }
      patch.stage_id = body.stage_id
      patch.stage_locked_at = nowIso
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nada para atualizar' }, { status: 400 })
    }

    const { error } = await supabase
      .from('deals')
      .update(patch)
      .eq('id', id)
      .eq('account_id', accountId)
    if (error) throw new Error(error.message)

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[deals/quick] failed:', err)
    return NextResponse.json({ error: 'Falha ao salvar' }, { status: 500 })
  }
}
