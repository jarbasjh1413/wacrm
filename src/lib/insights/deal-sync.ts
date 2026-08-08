/**
 * Ponte Radar → funil de vendas (051).
 *
 * "A IA colocar no pipeline o valor que o cliente está disposto a gastar,
 *  baseado no momento de compra." — Jarbas
 *
 * Três regras que protegem o board de quem usa:
 *   1. **Só cria negócio quando faz sentido**: intenção de compra e algum
 *      sinal concreto (valor mencionado ou lead esquentando). Curiosidade
 *      e assistência não viram card.
 *   2. **Só move o que ela mesma controla**: mexeu no valor ou arrastou o
 *      card na mão? Aquele campo fica travado para a IA (`*_locked_at`).
 *   3. **Nunca anda para trás**: o Radar só empurra o negócio adiante no
 *      funil — quem volta um card é gente, e a IA respeita.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** Vocabulário canônico — a IA fala nisso, nunca no nome do estágio real. */
export type RadarStage =
  | 'novo'
  | 'qualificado'
  | 'negociando'
  | 'reservado'
  | 'ganho'
  | 'perdido'

export const RADAR_STAGES: readonly RadarStage[] = [
  'novo',
  'qualificado',
  'negociando',
  'reservado',
  'ganho',
  'perdido',
]

/** Ordem de avanço no funil. 'perdido' fica fora — é saída lateral. */
const STAGE_ORDER: Record<RadarStage, number> = {
  novo: 0,
  qualificado: 1,
  negociando: 2,
  reservado: 3,
  ganho: 4,
  perdido: 99,
}

/** Os dois quadros. O funil de serviço é o PRÉ-loja (053). */
export type FunilTipo = 'vendas' | 'servico'

export interface DealSyncResult {
  dealId: string
  funil: FunilTipo
}

export interface DealSyncInput {
  accountId: string
  contactId: string
  conversationId: string
  /** Nome do contato — vira o título do negócio quando ele é criado. */
  contactName: string
  /** O que a pessoa quer, em uma frase (vira parte do título). */
  interesse: string | null
  /** Quanto ela pode gastar, segundo a conversa. */
  valorEstimado: number | null
  estagio: RadarStage | null
  temperatura: string
  intencao: string
  /** Em qual quadro a IA disse que esta conversa vive. null = não soube. */
  funil?: FunilTipo | null
}

interface StageRow {
  id: string
  pipeline_id: string
  position: number
  radar_stage: string | null
}

interface PipelineRow {
  id: string
  tipo: string
}

/**
 * Em qual quadro este cliente vive. A intenção sozinha não basta:
 * "quanto custa trocar a tela" e "quanto custa um notebook i5" são a mesma
 * intenção (orcamento) em quadros diferentes — por isso a IA declara, e a
 * intenção é só a rede embaixo.
 */
function escolheFunil(input: DealSyncInput): FunilTipo | null {
  if (input.funil === 'vendas' || input.funil === 'servico') return input.funil
  if (input.intencao === 'compra') return 'vendas'
  if (input.intencao === 'assistencia' || input.intencao === 'pos_venda') {
    return 'servico'
  }
  return null
}

/**
 * O teto da IA no funil de serviço. "Ganho" ali significa máquina na
 * bancada — quem confirma isso é o sistema de OS ou o botão manual, nunca
 * a conversa. O prompt pede; isto garante.
 */
function aplicaTeto(
  estagio: RadarStage | null,
  funil: FunilTipo | null,
): RadarStage | null {
  if (funil !== 'servico') return estagio
  if (estagio === 'ganho') return 'reservado'
  // Quem tem máquina com problema já é lead: entra no quadro mesmo que a
  // IA não saiba dizer o ponto da conversa.
  return estagio ?? 'novo'
}

/**
 * Cria ou atualiza o negócio desta conversa. Devolve o id do negócio
 * (ou null quando não havia motivo para criar um). Nunca lança — o
 * funil é consequência da análise, não pode derrubá-la.
 */
export async function syncDealFromRadar(
  db: SupabaseClient,
  input: DealSyncInput,
): Promise<DealSyncResult | null> {
  try {
    const pipelines = await loadPipelines(db, input.accountId)
    const funil = escolheFunil(input)
    const estagio = aplicaTeto(input.estagio, funil)
    const idsDoFunil = funil
      ? pipelines.filter((p) => p.tipo === funil).map((p) => p.id)
      : []

    // REGRA INVIOLÁVEL: sem funil daquele tipo, não faz nada. Nunca, em
    // hipótese alguma, despeja lead de conserto no quadro de vendas —
    // silêncio é melhor que quadro errado.
    if (funil && idsDoFunil.length === 0) return null

    let busca = db
      .from('deals')
      .select(
        'id, value, stage_id, status, pipeline_id, value_locked_at, stage_locked_at, created_by_radar',
      )
      .eq('account_id', input.accountId)
      .eq('contact_id', input.contactId)
    if (funil === 'servico') {
      // Card de serviço ganho é assunto encerrado: a máquina está lá dentro
      // e a OS manda nela. Sem isto, quem já teve máquina na bancada nunca
      // mais geraria card de conserto (segunda máquina, a da esposa...).
      busca = busca.eq('status', 'open')
    } else {
      busca = busca.neq('status', 'lost')
    }
    if (idsDoFunil.length > 0) busca = busca.in('pipeline_id', idsDoFunil)

    const { data: existing } = await busca
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!existing) {
      // Sem quadro decidido a IA não tem autoridade para abrir card.
      if (!funil) return null
      if (funil === 'vendas') {
        // Vendas: só com sinal concreto, senão o board enche de lixo.
        const temSinal =
          input.valorEstimado !== null ||
          input.temperatura === 'quente' ||
          (estagio !== null && STAGE_ORDER[estagio] >= 2)
        if (!temSinal) return null
      } else if (estagio === 'perdido') {
        // Serviço: barra mais baixa de propósito — quem tem máquina com
        // problema já é o lead que a loja não pode perder. Só não abre
        // card que já nasce morto.
        return null
      }
    }

    const pipelineAlvo = existing?.pipeline_id ?? idsDoFunil[0]
    if (!pipelineAlvo) return null

    const stages = await loadStages(db, pipelineAlvo)
    if (stages.length === 0) {
      return existing ? { dealId: existing.id, funil: funil ?? 'vendas' } : null
    }

    // Sem quadro decidido a IA pode acertar o valor, mas não move de coluna:
    // se ela não soube dizer se é venda ou conserto, não sabe em que ponto
    // do funil a conversa está.
    const alvo =
      funil && estagio ? stages.find((s) => s.radar_stage === estagio) : null

    if (!existing) {
      // Estágio de entrada: o mapeado, senão o primeiro do funil.
      const inicial = alvo ?? stages[0]
      const { data: created, error } = await db
        .from('deals')
        .insert({
          account_id: input.accountId,
          user_id: await resolveOwner(db, input.accountId),
          pipeline_id: inicial.pipeline_id,
          stage_id: inicial.id,
          contact_id: input.contactId,
          conversation_id: input.conversationId,
          title: input.interesse
            ? `${input.contactName} — ${input.interesse}`.slice(0, 120)
            : input.contactName,
          // No serviço o valor pré-loja é chute: só o orçamento da bancada
          // vale, e ele vem da OS.
          value: funil === 'servico' ? 0 : (input.valorEstimado ?? 0),
          currency: 'BRL',
          // deals.status só aceita open/won/lost (002).
          status: statusDoEstagio(estagio),
          created_by_radar: true,
        })
        .select('id')
        .single()
      if (error) {
        console.error('[deal-sync] criação falhou:', error.message)
        return null
      }
      return created?.id ? { dealId: created.id, funil: funil! } : null
    }

    // Já existe: atualiza só o que a IA ainda controla.
    const patch: Record<string, unknown> = {}

    if (
      funil !== 'servico' &&
      input.valorEstimado !== null &&
      !existing.value_locked_at &&
      Number(existing.value ?? 0) !== input.valorEstimado
    ) {
      patch.value = input.valorEstimado
    }

    if (alvo && !existing.stage_locked_at && alvo.id !== existing.stage_id) {
      const atual = stages.find((s) => s.id === existing.stage_id)
      // Duas travas contra andar para trás, e o card só se mexe se passar
      // nas duas. A da posição cobre o estágio que o dono criou e não
      // mapeou (radar_stage nulo): sem ela a IA puxaria de volta um card
      // que alguém arrastou no board.
      const avancaNaTela = !atual || alvo.position > atual.position
      const ordemAtual = atual?.radar_stage
        ? STAGE_ORDER[atual.radar_stage as RadarStage]
        : null
      const ordemNova = STAGE_ORDER[estagio as RadarStage]
      const avancaNoFunil = ordemAtual === null ? true : ordemNova > ordemAtual
      // 'perdido' é saída lateral: pode vir de qualquer lugar.
      if (estagio === 'perdido' || (avancaNoFunil && avancaNaTela)) {
        patch.stage_id = alvo.id
        // Ganhou/perdeu também é status, senão o card fica "aberto" na
        // coluna Comprou e os relatórios mentem.
        const status = statusDoEstagio(estagio)
        if (status !== existing.status) patch.status = status
      }
    }

    const resultado: DealSyncResult = {
      dealId: existing.id,
      funil:
        funil ??
        (pipelines.find((p) => p.id === existing.pipeline_id)?.tipo ===
        'servico'
          ? 'servico'
          : 'vendas'),
    }
    if (Object.keys(patch).length === 0) return resultado

    await db.from('deals').update(patch).eq('id', existing.id)
    return resultado
  } catch (err) {
    console.error('[deal-sync] falhou:', err)
    return null
  }
}

/** deals.status entende só open/won/lost — traduz do vocabulário do Radar. */
function statusDoEstagio(estagio: RadarStage | null): 'open' | 'won' | 'lost' {
  if (estagio === 'ganho') return 'won'
  if (estagio === 'perdido') return 'lost'
  return 'open'
}

/** Funis da conta, do mais antigo ao mais novo. */
async function loadPipelines(
  db: SupabaseClient,
  accountId: string,
): Promise<PipelineRow[]> {
  const { data } = await db
    .from('pipelines')
    .select('id, tipo')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
  return (data ?? []) as PipelineRow[]
}

/** Estágios de UM funil, do primeiro ao último. */
async function loadStages(
  db: SupabaseClient,
  pipelineId: string,
): Promise<StageRow[]> {
  const { data } = await db
    .from('pipeline_stages')
    .select('id, pipeline_id, position, radar_stage')
    .eq('pipeline_id', pipelineId)
    .order('position', { ascending: true })
  return (data ?? []) as StageRow[]
}

/** deals.user_id é NOT NULL — usa o dono da conta como autor. */
async function resolveOwner(
  db: SupabaseClient,
  accountId: string,
): Promise<string | null> {
  const { data } = await db
    .from('profiles')
    .select('user_id, account_role')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
    .limit(50)
  const rows = data ?? []
  return (
    rows.find((p) => p.account_role === 'owner')?.user_id ??
    rows[0]?.user_id ??
    null
  )
}

/** Normaliza o quadro devolvido pela IA. Lixo vira null, nunca quebra. */
export function parseFunil(raw: unknown): FunilTipo | null {
  const value = String(raw ?? '').trim().toLowerCase()
  return value === 'vendas' || value === 'servico' ? value : null
}

/** Normaliza o estágio devolvido pela IA. */
export function parseRadarStage(raw: unknown): RadarStage | null {
  const value = String(raw ?? '').toLowerCase()
  return (RADAR_STAGES as readonly string[]).includes(value)
    ? (value as RadarStage)
    : null
}

/**
 * Normaliza o valor que a IA leu da conversa. Recusa número absurdo —
 * a IA às vezes confunde "notebook i5 12ª geração" com dinheiro.
 */
export function parseValorEstimado(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').replace(/[^\d.]/g, ''))
  if (!Number.isFinite(n) || n <= 0) return null
  if (n > 1_000_000) return null
  return Math.round(n * 100) / 100
}
