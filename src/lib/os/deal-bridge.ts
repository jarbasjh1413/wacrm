/**
 * Ponte Ordem de Serviço → card do funil de serviço (053).
 *
 * A fronteira do projeto: até a máquina entrar na loja quem manda é o CRM;
 * depois que entra, quem manda é a OS. Esta função é o momento exato da
 * troca de turno.
 *
 * O que ela NÃO faz, de propósito:
 *   - **Nunca cria card.** Máquina que entrou pelo balcão sem nunca ter
 *     mandado mensagem não é lead do CRM. O funil de serviço mede a demanda
 *     que chegou pelo WhatsApp, não o movimento da loja.
 *   - **Não reproduz o kanban da OS.** Aquele quadro tem 12 colunas e é a
 *     verdade do conserto; copiá-lo aqui garantiria que os dois
 *     discordassem. O card só guarda o espelho (`os_status`) para mostrar.
 *   - **Não lança.** O funil é consequência; nunca pode derrubar o 201 que
 *     o sistema de OS está esperando.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { mapOsSituacao, maquinaChegou } from './status-map'

export interface OsBridgeInput {
  accountId: string
  contactId: string
  osId: string
  status: string | null
}

export async function aplicaOsNoFunilDeServico(
  db: SupabaseClient,
  input: OsBridgeInput,
): Promise<void> {
  try {
    const { data: funis } = await db
      .from('pipelines')
      .select('id')
      .eq('account_id', input.accountId)
      .eq('tipo', 'servico')
    const ids = (funis ?? []).map((f) => f.id)
    if (ids.length === 0) return

    const { data: deal } = await db
      .from('deals')
      .select('id, status, stage_id, pipeline_id, os_id, os_status, stage_locked_at')
      .eq('account_id', input.accountId)
      .eq('contact_id', input.contactId)
      .in('pipeline_id', ids)
      .neq('status', 'lost')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!deal) return

    const situacao = mapOsSituacao(input.status)
    // os_events é histórico sem UNIQUE e o contrato diz que reenviar é
    // seguro — a idempotência tem de ser nossa.
    if (deal.os_id === input.osId && deal.os_status === situacao) return

    const agora = new Date().toISOString()
    const patch: Record<string, unknown> = {
      os_id: input.osId,
      os_status: situacao,
      os_atualizada_em: agora,
    }

    // Só o momento da CHEGADA move o card. "Aguardando recebimento" é OS
    // aberta com a máquina ainda na casa do cliente: o card fica onde
    // está e a cobrança de "que dia você traz?" continua valendo.
    if (maquinaChegou(input.status) && deal.status === 'open') {
      if (deal.stage_locked_at) {
        // Alguém arrastou este card à mão. Decisão humana é soberana: a
        // ponte só espelha a OS e deixa a coluna como a pessoa deixou.
        console.warn(
          `[os-bridge] card ${deal.id} está travado à mão — só espelhando a OS`,
        )
      } else {
        const { data: alvo } = await db
          .from('pipeline_stages')
          .select('id')
          .eq('pipeline_id', deal.pipeline_id)
          .eq('radar_stage', 'ganho')
          .limit(1)
          .maybeSingle()
        if (alvo && alvo.id !== deal.stage_id) {
          patch.stage_id = alvo.id
          patch.status = 'won'
          // A partir daqui a OS assume: a IA não mexe mais em coluna nem
          // em valor deste card. Usa as mesmas travas da soberania humana
          // (051) — é um evento único e terminal, não um automatismo.
          patch.stage_locked_at = agora
          patch.value_locked_at = agora
        }
      }
    }

    await db.from('deals').update(patch).eq('id', deal.id)
  } catch (err) {
    console.error('[os-bridge] falhou:', err)
  }
}
