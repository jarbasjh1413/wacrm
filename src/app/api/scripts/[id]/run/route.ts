/**
 * Dispara um script de mensagens na conversa aberta (FASE 3, §8).
 * POST /api/scripts/{id}/run  body: { conversation_id }
 *
 * Roda a sequência inteira dentro da request (itens × delays de poucos
 * segundos) — o agente vê as mensagens pingando no thread em tempo
 * real via realtime, como se ele mesmo tivesse digitado.
 */

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveAccountId } from '@/lib/whatsapp/evolution-config'
import { runScriptInConversation } from '@/lib/whatsapp/script-runner'
import { SendMessageError } from '@/lib/whatsapp/send-message'

export const dynamic = 'force-dynamic'
// Sequência longa (itens × delay) precisa de folga além do padrão.
export const maxDuration = 120

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: scriptId } = await params
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
    const conversationId = body?.conversation_id
    if (!conversationId || typeof conversationId !== 'string') {
      return NextResponse.json(
        { error: 'conversation_id é obrigatório' },
        { status: 400 },
      )
    }

    const result = await runScriptInConversation(supabase, accountId, {
      scriptId,
      conversationId,
    })
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof SendMessageError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    console.error('[scripts/run] failed:', err)
    return NextResponse.json(
      { error: 'Falha ao executar o script' },
      { status: 500 },
    )
  }
}
