/**
 * Correção humana da classificação do Radar (047) — o "consenso IA +
 * humano" que o Jarbas pediu.
 *
 * POST /api/radar/{conversationId}/classify
 *   body: { campo: 'temperatura'|'intencao', valor: string }
 *
 * Três efeitos:
 *   1. grava a correção (vira exemplo no prompt das próximas análises);
 *   2. fixa o campo — a IA não sobrescreve mais aquela classificação;
 *   3. reaplica as etiquetas do contato para refletir a escolha humana.
 */

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveAccountId } from '@/lib/whatsapp/evolution-config'
import {
  reapplyRadarTagsForConversation,
  type Intencao,
  type Temperatura,
} from '@/lib/insights/analyzer'

export const dynamic = 'force-dynamic'

const VALORES: Record<string, readonly string[]> = {
  temperatura: ['quente', 'morno', 'frio', 'indefinido'],
  intencao: [
    'compra',
    'assistencia',
    'orcamento',
    'informacao',
    'pos_venda',
    'outro',
    'indefinido',
  ],
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  try {
    const { conversationId } = await params
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
    const campo = body?.campo
    const valor = body?.valor
    if (campo !== 'temperatura' && campo !== 'intencao') {
      return NextResponse.json(
        { error: "campo deve ser 'temperatura' ou 'intencao'" },
        { status: 400 },
      )
    }
    if (typeof valor !== 'string' || !VALORES[campo].includes(valor)) {
      return NextResponse.json({ error: 'valor inválido' }, { status: 400 })
    }

    const { data: insight } = await supabase
      .from('conversation_insights')
      .select('temperatura, intencao, resumo, contact_id')
      .eq('conversation_id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!insight) {
      return NextResponse.json(
        { error: 'Esta conversa ainda não foi analisada pelo Radar.' },
        { status: 404 },
      )
    }

    const valorIa =
      ((insight as Record<string, unknown>)[campo] as string | null) ??
      'indefinido'
    const nowIso = new Date().toISOString()

    // Só registra correção quando o humano DISCORDA — reconfirmar o que
    // a IA já disse não é exemplo de aprendizado.
    if (valorIa !== valor) {
      await supabase.from('radar_corrections').insert({
        account_id: accountId,
        conversation_id: conversationId,
        campo,
        valor_ia: valorIa,
        valor_humano: valor,
        contexto: insight.resumo,
        corrigido_por: user.id,
      })
    }

    const { error: updateError } = await supabase
      .from('conversation_insights')
      .update({
        [campo]: valor,
        [`${campo}_fixada_em`]: nowIso,
      })
      .eq('conversation_id', conversationId)
      .eq('account_id', accountId)
    if (updateError) throw new Error(updateError.message)

    // Etiquetas seguem a decisão humana na hora (o funil precisa estar
    // certo antes da próxima varredura).
    if (insight.contact_id) {
      await reapplyRadarTagsForConversation(accountId, insight.contact_id, {
        temperatura: (campo === 'temperatura'
          ? valor
          : (insight.temperatura ?? 'indefinido')) as Temperatura,
        intencao: (campo === 'intencao'
          ? valor
          : (insight.intencao ?? 'indefinido')) as Intencao,
      }).catch((err) =>
        console.error('[radar/classify] reetiquetagem falhou:', err),
      )
    }

    return NextResponse.json({ campo, valor })
  } catch (err) {
    console.error('[radar/classify] failed:', err)
    return NextResponse.json(
      { error: 'Falha ao salvar a classificação' },
      { status: 500 },
    )
  }
}
