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
 *     verdade do conserto. O CRM tem QUATRO colunas dirigidas pela OS —
 *     as que mudam o que ele tem a DIZER ao cliente: na bancada,
 *     orçamento enviado, pronta pra retirar, entregue. O resto (autorizado,
 *     em serviço, aguardando peça) é trabalho interno e vive na OS.
 *
 * A IA não consegue mexer nessas colunas nem querendo: elas têm
 * `radar_stage` nulo, e o deal-sync só move para estágio com palavra
 * canônica. Dois motores, sem colisão.
 *   - **Não lança.** O funil é consequência; nunca pode derrubar o 201 que
 *     o sistema de OS está esperando.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { mapOsSituacao } from './status-map'

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

    if (situacao !== 'desconhecido' && deal.status !== 'lost') {
      // Colunas dirigidas pela OS (054): o card segue o conserto de
      // verdade — na bancada → orçamento enviado → pronta → entregue.
      const { data: stages } = await db
        .from('pipeline_stages')
        .select('id, position, os_situacao')
        .eq('pipeline_id', deal.pipeline_id)
        .order('position', { ascending: true })
      const lista = (stages ?? []) as {
        id: string
        position: number
        os_situacao: string | null
      }[]
      const alvo = lista.find((s) => s.os_situacao === situacao)
      const atual = lista.find((s) => s.id === deal.stage_id)

      if (alvo && alvo.id !== deal.stage_id) {
        if (deal.stage_locked_at) {
          // Alguém arrastou este card à mão. Decisão humana é soberana:
          // a ponte só espelha a OS e deixa a coluna onde a pessoa pôs.
          console.warn(
            `[os-bridge] card ${deal.id} travado à mão — só espelhando a OS`,
          )
        } else if (!atual || alvo.position > atual.position) {
          // Só adiante. OS que volta de coluna (voltou pra bancada) não
          // arrasta o card para trás — quem faz isso é gente.
          patch.stage_id = alvo.id
          if (situacao === 'finalizada') patch.status = 'won'
        }
      }
    }

    await db.from('deals').update(patch).eq('id', deal.id)
  } catch (err) {
    console.error('[os-bridge] falhou:', err)
  }
}
