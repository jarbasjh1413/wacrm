/**
 * Fila de mensagens agendadas (FASE 3, CLAUDE.md §8): "escrever agora,
 * enviar depois". Cada linha de scheduled_messages vencida dispara um
 * texto simples OU um script inteiro na conversa, na data/hora que o
 * agente escolheu — o horário é escolha explícita do humano, então é
 * respeitado como está (as regras de janela/teto da §11 valem para
 * disparos em massa; aqui é 1:1 com hora marcada).
 *
 * Drenada pelo mesmo relógio do servidor dos broadcasts
 * (instrumentation.ts) e pelo backstop GET /api/scheduled/cron.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { sendMessageToConversation } from './send-message'
import { runScriptInConversation } from './script-runner'
import { renderBroadcastMessage } from './broadcast-pacing'

let _admin: SupabaseClient | null = null
function admin(): SupabaseClient {
  if (!_admin) {
    _admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _admin
}

interface ScheduledRow {
  id: string
  account_id: string
  conversation_id: string
  content_text: string | null
  script_id: string | null
}

export interface ScheduledDrainResult {
  sent: number
  failed: number
}

/** Envia toda scheduled_message vencida. Erros por linha não travam as demais. */
export async function drainScheduledMessages(
  now: Date = new Date(),
): Promise<ScheduledDrainResult> {
  const db = admin()
  const result: ScheduledDrainResult = { sent: 0, failed: 0 }

  const { data: due, error } = await db
    .from('scheduled_messages')
    .select('id, account_id, conversation_id, content_text, script_id')
    .eq('status', 'scheduled')
    .lte('send_at', now.toISOString())
    .order('send_at', { ascending: true })
    .limit(20)
  if (error) {
    console.error('[scheduled-queue] failed to list due messages:', error.message)
    return result
  }

  for (const row of (due ?? []) as ScheduledRow[]) {
    // Marca como 'sent' ANTES do envio (claim otimista): se dois ticks
    // concorrerem, só um leva a linha — o update é condicionado ao
    // status ainda ser 'scheduled'. Em falha, vira 'failed' com motivo.
    const { data: claimed } = await db
      .from('scheduled_messages')
      .update({ status: 'sent', sent_at: now.toISOString() })
      .eq('id', row.id)
      .eq('status', 'scheduled')
      .select('id')
    if (!claimed || claimed.length === 0) continue

    try {
      if (row.script_id) {
        await runScriptInConversation(db, row.account_id, {
          scriptId: row.script_id,
          conversationId: row.conversation_id,
        })
      } else {
        // Variáveis também funcionam em agendadas de texto simples.
        const { data: conversation } = await db
          .from('conversations')
          .select('id, contact:contacts(name, phone)')
          .eq('id', row.conversation_id)
          .maybeSingle()
        const contactRaw = conversation?.contact
        const contact =
          (Array.isArray(contactRaw) ? contactRaw[0] : contactRaw) ?? {
            name: null,
            phone: null,
          }
        await sendMessageToConversation(db, row.account_id, {
          conversationId: row.conversation_id,
          messageType: 'text',
          contentText: renderBroadcastMessage(row.content_text ?? '', contact),
        })
      }
      result.sent++
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'falha desconhecida'
      await db
        .from('scheduled_messages')
        .update({ status: 'failed', error_message: reason })
        .eq('id', row.id)
      result.failed++
      console.error(`[scheduled-queue] agendada ${row.id} falhou:`, reason)
    }
  }

  return result
}
