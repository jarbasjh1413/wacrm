/**
 * Decisão humana sobre uma sugestão de follow-up (FASE 5, §10).
 * POST /api/followups/{id}/decide  body: { action: 'approve'|'discard', mensagem_final? }
 *
 * approve → envia a mensagem (a final, que pode ter sido editada) pela
 * conversa e marca sent (igual à sugerida) ou edited (mexeu no texto —
 * a diferença alimenta o aprendizado de prompt do §10).
 * discard → só marca discarded.
 * Roda com o client da SESSÃO (RLS agent+), então viewer não decide.
 */

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  sendMessageToConversation,
  SendMessageError,
} from '@/lib/whatsapp/send-message'
import { resolveAccountId } from '@/lib/whatsapp/evolution-config'

export const dynamic = 'force-dynamic'

export async function POST(
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
      return NextResponse.json(
        { error: 'Seu perfil não está vinculado a uma conta.' },
        { status: 400 },
      )
    }

    const body = await request.json().catch(() => ({}))
    const action = body?.action
    if (action !== 'approve' && action !== 'discard') {
      return NextResponse.json(
        { error: "action deve ser 'approve' ou 'discard'" },
        { status: 400 },
      )
    }

    const { data: suggestion } = await supabase
      .from('followup_suggestions')
      .select('*')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!suggestion) {
      return NextResponse.json({ error: 'Sugestão não encontrada' }, { status: 404 })
    }
    if (suggestion.status !== 'pending') {
      return NextResponse.json(
        { error: 'Esta sugestão já foi decidida' },
        { status: 409 },
      )
    }

    const nowIso = new Date().toISOString()

    if (action === 'discard') {
      const { error } = await supabase
        .from('followup_suggestions')
        .update({ status: 'discarded', decided_at: nowIso, decided_by: user.id })
        .eq('id', id)
        .eq('status', 'pending')
      if (error) throw new Error(error.message)
      return NextResponse.json({ status: 'discarded' })
    }

    const mensagemFinal =
      typeof body?.mensagem_final === 'string' && body.mensagem_final.trim()
        ? body.mensagem_final.trim()
        : (suggestion.mensagem_sugerida as string)

    await sendMessageToConversation(supabase, accountId, {
      conversationId: suggestion.conversation_id,
      messageType: 'text',
      contentText: mensagemFinal,
    })

    const finalStatus =
      mensagemFinal === suggestion.mensagem_sugerida ? 'sent' : 'edited'
    const { error } = await supabase
      .from('followup_suggestions')
      .update({
        status: finalStatus,
        mensagem_final: mensagemFinal,
        decided_at: nowIso,
        decided_by: user.id,
      })
      .eq('id', id)
      .eq('status', 'pending')
    if (error) throw new Error(error.message)

    return NextResponse.json({ status: finalStatus })
  } catch (err) {
    if (err instanceof SendMessageError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error('[followups/decide] failed:', err)
    return NextResponse.json({ error: 'Falha ao decidir a sugestão' }, { status: 500 })
  }
}
