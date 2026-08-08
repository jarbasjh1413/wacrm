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
}

interface StageRow {
  id: string
  pipeline_id: string
  position: number
  radar_stage: string | null
}

/**
 * Cria ou atualiza o negócio desta conversa. Devolve o id do negócio
 * (ou null quando não havia motivo para criar um). Nunca lança — o
 * funil é consequência da análise, não pode derrubá-la.
 */
export async function syncDealFromRadar(
  db: SupabaseClient,
  input: DealSyncInput,
): Promise<string | null> {
  try {
    const { data: existing } = await db
      .from('deals')
      .select('id, value, stage_id, status, value_locked_at, stage_locked_at, created_by_radar')
      .eq('account_id', input.accountId)
      .eq('contact_id', input.contactId)
      .neq('status', 'lost')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // Sem negócio ainda: só vale abrir um quando há intenção de compra E
    // um sinal concreto. Abrir card para quem só perguntou o horário
    // entupiria o funil de lixo.
    if (!existing) {
      const vaiComprar = input.intencao === 'compra'
      const temSinal =
        input.valorEstimado !== null ||
        input.temperatura === 'quente' ||
        (input.estagio !== null && STAGE_ORDER[input.estagio] >= 2)
      if (!vaiComprar || !temSinal) return null
    }

    const stages = await loadStages(db, input.accountId)
    if (stages.length === 0) return existing?.id ?? null

    const alvo = input.estagio ? stages.find((s) => s.radar_stage === input.estagio) : null

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
          value: input.valorEstimado ?? 0,
          currency: 'BRL',
          // deals.status só aceita open/won/lost (002).
          status: statusDoEstagio(input.estagio),
          created_by_radar: true,
        })
        .select('id')
        .single()
      if (error) {
        console.error('[deal-sync] criação falhou:', error.message)
        return null
      }
      return created?.id ?? null
    }

    // Já existe: atualiza só o que a IA ainda controla.
    const patch: Record<string, unknown> = {}

    if (
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
      const ordemNova = STAGE_ORDER[input.estagio as RadarStage]
      const avancaNoFunil = ordemAtual === null ? true : ordemNova > ordemAtual
      // 'perdido' é saída lateral: pode vir de qualquer lugar.
      if (input.estagio === 'perdido' || (avancaNoFunil && avancaNaTela)) {
        patch.stage_id = alvo.id
        // Ganhou/perdeu também é status, senão o card fica "aberto" na
        // coluna Comprou e os relatórios mentem.
        const status = statusDoEstagio(input.estagio)
        if (status !== existing.status) patch.status = status
      }
    }

    if (Object.keys(patch).length === 0) return existing.id

    await db.from('deals').update(patch).eq('id', existing.id)
    return existing.id
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

/** Estágios do funil da conta, do primeiro ao último. */
async function loadStages(
  db: SupabaseClient,
  accountId: string,
): Promise<StageRow[]> {
  const { data: pipeline } = await db
    .from('pipelines')
    .select('id')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!pipeline) return []

  const { data } = await db
    .from('pipeline_stages')
    .select('id, pipeline_id, position, radar_stage')
    .eq('pipeline_id', pipeline.id)
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
