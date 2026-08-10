/**
 * Conversão entre quadros (053/054): o card NUNCA troca de funil — nasce
 * um card novo no quadro de destino, amarrado ao original, e o original
 * fecha com o motivo. É deste amarrado que sai o relatório mais valioso
 * da loja: "quantos consertos inviáveis viraram venda, e quanto rendeu".
 *
 * POST /api/deals/{id}/converter
 *   body: { para: 'vendas' | 'servico', motivo: string, obs?: string }
 *
 * Recusas deliberadas:
 *   - Card cuja coluna é dirigida pela OS (máquina na loja em diante)
 *     NÃO é fechado: consertar o velho E comprar um novo é rotina, e a
 *     máquina continua fisicamente na bancada. Só amarra.
 *   - Sempre exige motivo — sem ele o relatório não existe.
 */

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveAccountId } from '@/lib/whatsapp/evolution-config'

export const dynamic = 'force-dynamic'

const MOTIVOS = new Set([
  'virou_venda',
  'virou_servico',
  'resolvido_sem_os',
  'preco',
  'nao_apareceu',
  'sem_resposta',
  'concorrente',
  'funil_errado',
  'outro',
])

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
      return NextResponse.json({ error: 'Sem conta vinculada' }, { status: 400 })
    }

    const body = await request.json().catch(() => ({}))
    const para = body.para === 'servico' ? 'servico' : body.para === 'vendas' ? 'vendas' : null
    const motivo = typeof body.motivo === 'string' && MOTIVOS.has(body.motivo) ? body.motivo : null
    if (!para || !motivo) {
      return NextResponse.json({ error: 'Destino e motivo são obrigatórios' }, { status: 400 })
    }

    const { data: origem } = await supabase
      .from('deals')
      .select(
        'id, title, value, contact_id, conversation_id, status, stage_id, pipeline_id, stage:pipeline_stages(os_situacao)',
      )
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!origem) {
      return NextResponse.json({ error: 'Negócio não encontrado' }, { status: 404 })
    }

    // Funil de destino: o mais antigo daquele tipo (o mesmo que o Radar usa).
    const { data: destinoFunil } = await supabase
      .from('pipelines')
      .select('id')
      .eq('account_id', accountId)
      .eq('tipo', para)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (!destinoFunil) {
      return NextResponse.json(
        { error: `Não existe funil de ${para} nesta conta` },
        { status: 400 },
      )
    }
    const { data: primeiraColuna } = await supabase
      .from('pipeline_stages')
      .select('id')
      .eq('pipeline_id', destinoFunil.id)
      .order('position', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (!primeiraColuna) {
      return NextResponse.json({ error: 'Funil de destino sem colunas' }, { status: 400 })
    }

    const { data: novo, error: criaErro } = await supabase
      .from('deals')
      .insert({
        account_id: accountId,
        user_id: user.id,
        pipeline_id: destinoFunil.id,
        stage_id: primeiraColuna.id,
        contact_id: origem.contact_id,
        conversation_id: origem.conversation_id,
        title: origem.title,
        value: 0,
        currency: 'BRL',
        status: 'open',
        relacionado_deal_id: origem.id,
      })
      .select('id')
      .single()
    if (criaErro || !novo) {
      return NextResponse.json({ error: 'Falha ao criar o negócio novo' }, { status: 500 })
    }

    // Amarra nos dois sentidos e fecha a origem — salvo quando a máquina
    // já está na loja (coluna dirigida pela OS): aí só amarra.
    const stageRaw = origem.stage as unknown
    const stage = Array.isArray(stageRaw) ? stageRaw[0] : stageRaw
    const osManda = Boolean((stage as { os_situacao?: string | null })?.os_situacao)
    const patch: Record<string, unknown> = { relacionado_deal_id: novo.id }
    let fechada = false
    if (!osManda && origem.status === 'open') {
      patch.status = 'lost'
      patch.motivo_perda = motivo
      if (typeof body.obs === 'string' && body.obs.trim()) {
        patch.motivo_perda_obs = body.obs.trim().slice(0, 500)
      }
      fechada = true
    }
    await supabase.from('deals').update(patch).eq('id', origem.id)

    return NextResponse.json({ ok: true, novoDealId: novo.id, origemFechada: fechada })
  } catch (err) {
    console.error('[deals/converter] failed:', err)
    return NextResponse.json({ error: 'Falha ao converter' }, { status: 500 })
  }
}
