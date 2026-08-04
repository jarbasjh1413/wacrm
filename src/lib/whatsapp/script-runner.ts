/**
 * Executor de scripts de mensagens (FASE 3, CLAUDE.md §8).
 *
 * Um script é uma sequência ordenada de itens (texto/mídia) enviada de
 * uma vez numa conversa — o substituto dos "scripts" da WA Scale, ex.:
 * "Garantia" = vídeo + 2 textos. Cada item espera `delay_seconds` após
 * o anterior (pausa natural, parece digitação humana) e passa pelas
 * variáveis {{nome}}/{{primeiro_nome}}/{{telefone}} do contato.
 *
 * O envio reusa sendMessageToConversation — o mesmo caminho do inbox
 * (resolve a instância, insere a mensagem no thread, trata nono
 * dígito), então o agente vê a sequência saindo em tempo real.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  sendMessageToConversation,
  SendMessageError,
} from './send-message'
import { renderBroadcastMessage } from './broadcast-pacing'

export interface ScriptItemRow {
  id: string
  position: number
  item_type: 'text' | 'image' | 'video' | 'document' | 'audio'
  content_text: string | null
  media_url: string | null
  filename: string | null
  delay_seconds: number
}

export interface RunScriptResult {
  sentCount: number
  totalItems: number
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Dispara a sequência completa do script na conversa. Para no primeiro
 * item que falhar (mandar metade de um script fora de ordem confunde
 * mais do que ajuda) — o erro carrega quantos itens já saíram.
 */
export async function runScriptInConversation(
  db: SupabaseClient,
  accountId: string,
  args: { scriptId: string; conversationId: string },
): Promise<RunScriptResult> {
  const { scriptId, conversationId } = args

  const { data: script, error: scriptErr } = await db
    .from('message_scripts')
    .select('id, account_id, name')
    .eq('id', scriptId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (scriptErr || !script) {
    throw new SendMessageError('not_found', 'Script não encontrado', 404)
  }

  const { data: items, error: itemsErr } = await db
    .from('message_script_items')
    .select('id, position, item_type, content_text, media_url, filename, delay_seconds')
    .eq('script_id', scriptId)
    .order('position', { ascending: true })
  if (itemsErr || !items || items.length === 0) {
    throw new SendMessageError('bad_request', 'Este script não tem itens', 400)
  }

  // Contato da conversa para renderizar as variáveis.
  const { data: conversation } = await db
    .from('conversations')
    .select('id, contact:contacts(name, phone)')
    .eq('id', conversationId)
    .maybeSingle()
  const contactRaw = conversation?.contact
  const contact = (Array.isArray(contactRaw) ? contactRaw[0] : contactRaw) ?? {
    name: null,
    phone: null,
  }

  let sentCount = 0
  for (const [index, item] of (items as ScriptItemRow[]).entries()) {
    // Pausa natural entre mensagens — nunca antes da primeira.
    if (index > 0 && item.delay_seconds > 0) {
      await sleep(item.delay_seconds * 1000)
    }

    const rendered = item.content_text
      ? renderBroadcastMessage(item.content_text, contact)
      : null

    try {
      await sendMessageToConversation(db, accountId, {
        conversationId,
        messageType: item.item_type,
        contentText: rendered,
        mediaUrl: item.media_url,
        filename: item.filename,
      })
      sentCount++
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : 'falha desconhecida no envio'
      throw new SendMessageError(
        'script_item_failed',
        `Script "${script.name}" parou no item ${index + 1}/${items.length}: ${reason}`,
        502,
      )
    }
  }

  return { sentCount, totalItems: items.length }
}
