/**
 * Reações a mensagens RECEBIDAS que afetam broadcasts — compartilhado
 * pelos webhooks Meta e Evolution:
 *
 *   1. flagBroadcastReplyIfAny — quem responde um broadcast ainda sem
 *      resposta vira status 'replied' (alimenta o replied_count).
 *   2. applyOptOutIfRequested — §11.5: resposta de opt-out ("parar",
 *      "sair", "não quero"…) aplica a tag `nao-contatar` ao contato; a
 *      fila de broadcasts pula qualquer contato com essa tag.
 *
 * Tudo best-effort: falha aqui nunca pode quebrar o fluxo principal de
 * gravação da mensagem, então erros são engolidos com log.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { OPTOUT_TAG } from './broadcast-queue'

/**
 * Mensagens EXATAS (após normalização) que valem como pedido de saída.
 * Igualdade estrita de propósito: "para" dentro de uma frase não conta,
 * só a mensagem inteira sendo o comando.
 */
const OPTOUT_KEYWORDS = new Set([
  'parar',
  'pare',
  'para',
  'sair',
  'stop',
  'cancelar',
  'remover',
  'descadastrar',
  'nao quero',
  'nao quero mais',
  'nao quero receber',
])

/** minúsculas + sem acentos + espaços colapsados + sem pontuação final. */
function normalizeForOptOut(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export async function flagBroadcastReplyIfAny(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<void> {
  try {
    // Broadcast mais recente da conta ainda sem resposta deste contato.
    // Escopo por conta: a resposta conta independente de quem enviou.
    const { data: recs, error } = await db
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !recs || recs.length === 0) return

    const { error: updErr } = await db
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', recs[0].id)

    if (updErr) {
      console.error('Error marking broadcast recipient replied:', updErr)
    }
  } catch (err) {
    console.error('flagBroadcastReplyIfAny failed:', err)
  }
}

/**
 * Aplica a tag `nao-contatar` se a mensagem for um pedido de opt-out.
 * Retorna true quando o opt-out foi aplicado (o chamador pode logar).
 */
export async function applyOptOutIfRequested(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  messageText: string | null | undefined,
): Promise<boolean> {
  try {
    if (!messageText) return false
    if (!OPTOUT_KEYWORDS.has(normalizeForOptOut(messageText))) return false

    // find-or-create da tag na conta.
    let tagId: string | null = null
    const { data: existing } = await db
      .from('tags')
      .select('id')
      .eq('account_id', accountId)
      .eq('name', OPTOUT_TAG)
      .maybeSingle()
    tagId = existing?.id ?? null

    if (!tagId) {
      // tags.user_id é NOT NULL (schema 001) — usa o dono da conta.
      // ATENÇÃO: o papel de conta vive em `account_role` (enum da 017);
      // `profiles.role` é a coluna TEXT legada, que vale 'user' para
      // todo mundo. Filtrar por ela nunca casava e o opt-out (§11.5)
      // silenciosamente não criava a tag. Sem owner, cai em qualquer
      // membro — a tag precisa existir mais do que precisa de dono.
      const { data: owner } = await db
        .from('profiles')
        .select('user_id, account_role')
        .eq('account_id', accountId)
        .order('created_at', { ascending: true })
        .limit(50)
        .then((res) => ({
          data:
            res.data?.find((p) => p.account_role === 'owner') ??
            res.data?.[0] ??
            null,
        }))
      if (!owner) return false
      const { data: created, error: createErr } = await db
        .from('tags')
        .insert({
          account_id: accountId,
          user_id: owner.user_id,
          name: OPTOUT_TAG,
          color: '#ef4444',
        })
        .select('id')
        .single()
      if (createErr || !created) {
        console.error('applyOptOut: failed to create tag:', createErr)
        return false
      }
      tagId = created.id
    }

    const { error: linkErr } = await db
      .from('contact_tags')
      .upsert(
        { contact_id: contactId, tag_id: tagId },
        { onConflict: 'contact_id,tag_id', ignoreDuplicates: true },
      )
    if (linkErr) {
      console.error('applyOptOut: failed to tag contact:', linkErr)
      return false
    }
    return true
  } catch (err) {
    console.error('applyOptOutIfRequested failed:', err)
    return false
  }
}
