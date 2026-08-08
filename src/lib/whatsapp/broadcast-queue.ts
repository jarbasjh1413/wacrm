/**
 * Fila de envio dos broadcasts inteligentes (mensagens livres, motor
 * Evolution) — CLAUDE.md §6.5 + §11.
 *
 * Modelo: o broadcast fica com status 'sending' e um relógio
 * `next_send_at`. A cada drenagem, cada broadcast devido envia UM
 * destinatário e reagenda `next_send_at` com jitter aleatório
 * (30–120s por padrão) — nunca uma rajada. Fora da janela de horário
 * comercial ou acima do teto diário, o broadcast dorme até a próxima
 * oportunidade. Quem chama `drainBroadcastQueue()`:
 *   - instrumentation.ts (setInterval no servidor Next — dev e VPS);
 *   - GET /api/broadcasts/cron (x-cron-secret) como backstop externo.
 *
 * Broadcasts da era Meta (template_name preenchido, message_text nulo)
 * NÃO passam por aqui — seguem o caminho antigo do dashboard/API v1.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  loadSendConfig,
  transportSend,
  isVariantRetryableError,
} from './engine-transport'
import { phoneVariants, sanitizePhoneForMeta } from './phone-utils'
import { featureEnabled } from '@/lib/features/guard'
import {
  DEFAULT_LIMITS,
  isWithinSendWindow,
  jitterDelayMs,
  nextWindowStart,
  renderBroadcastMessage,
  type BroadcastLimits,
} from './broadcast-pacing'

/** Tag que suprime o contato de qualquer disparo (§11.5, opt-out). */
export const OPTOUT_TAG = 'nao-contatar'

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

interface QueueBroadcastRow {
  id: string
  account_id: string
  status: string
  message_text: string
  next_send_at: string | null
}

export interface DrainResult {
  sent: number
  failed: number
  finished: number
  slept: number
}

/**
 * Uma passada da fila: promove agendados devidos, e para cada broadcast
 * 'sending' devido envia um destinatário (ou o coloca para dormir).
 * Erros por broadcast não derrubam a drenagem dos demais.
 */
export async function drainBroadcastQueue(
  now: Date = new Date(),
): Promise<DrainResult> {
  const db = admin()
  const result: DrainResult = { sent: 0, failed: 0, finished: 0, slept: 0 }

  // Agendados que chegaram na hora entram na fila.
  await db
    .from('broadcasts')
    .update({ status: 'sending', next_send_at: now.toISOString() })
    .eq('status', 'scheduled')
    .not('message_text', 'is', null)
    .lte('scheduled_at', now.toISOString())

  const { data: due, error } = await db
    .from('broadcasts')
    .select('id, account_id, status, message_text, next_send_at')
    .eq('status', 'sending')
    .not('message_text', 'is', null)
    .or(`next_send_at.is.null,next_send_at.lte.${now.toISOString()}`)
    .order('next_send_at', { ascending: true, nullsFirst: true })
    .limit(20)
  if (error) {
    console.error('[broadcast-queue] failed to list due broadcasts:', error.message)
    return result
  }

  const limitsCache = new Map<string, BroadcastLimits>()

  for (const broadcast of (due ?? []) as QueueBroadcastRow[]) {
    try {
      // Central de Recursos (049): modo manual pausa a fila — a
      // transmissão fica em 'sending' e retoma de onde parou.
      if (!(await featureEnabled(db, broadcast.account_id, 'broadcasts'))) {
        continue
      }
      await processOne(db, broadcast, now, limitsCache, result)
    } catch (err) {
      // Nunca travar a fila: reagenda o broadcast problemático para
      // daqui a 15 min e segue para os demais.
      console.error(
        `[broadcast-queue] broadcast ${broadcast.id} falhou na drenagem:`,
        err instanceof Error ? err.message : err,
      )
      await db
        .from('broadcasts')
        .update({ next_send_at: new Date(now.getTime() + 15 * 60_000).toISOString() })
        .eq('id', broadcast.id)
    }
  }

  return result
}

async function loadLimits(
  db: SupabaseClient,
  accountId: string,
  cache: Map<string, BroadcastLimits>,
): Promise<BroadcastLimits> {
  const cached = cache.get(accountId)
  if (cached) return cached
  const { data } = await db
    .from('broadcast_limits')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()
  const limits: BroadcastLimits = data
    ? {
        daily_cap: data.daily_cap,
        min_delay_seconds: data.min_delay_seconds,
        max_delay_seconds: data.max_delay_seconds,
        send_window_start: data.send_window_start,
        send_window_end: data.send_window_end,
        send_days: data.send_days ?? DEFAULT_LIMITS.send_days,
        timezone: data.timezone ?? DEFAULT_LIMITS.timezone,
      }
    : DEFAULT_LIMITS
  cache.set(accountId, limits)
  return limits
}

/** Enviados nas últimas 24h na conta (janela deslizante do teto §11.2). */
async function sentInLast24h(
  db: SupabaseClient,
  accountId: string,
  now: Date,
): Promise<number> {
  const since = new Date(now.getTime() - 24 * 60 * 60_000).toISOString()
  const { count } = await db
    .from('broadcast_recipients')
    .select('id, broadcasts!inner(account_id)', { count: 'exact', head: true })
    .eq('broadcasts.account_id', accountId)
    .gte('sent_at', since)
  return count ?? 0
}

async function isOptedOut(
  db: SupabaseClient,
  contactId: string,
): Promise<boolean> {
  const { data } = await db
    .from('contact_tags')
    .select('id, tags!inner(name)')
    .eq('contact_id', contactId)
    .eq('tags.name', OPTOUT_TAG)
    .limit(1)
  return (data?.length ?? 0) > 0
}

async function processOne(
  db: SupabaseClient,
  broadcast: QueueBroadcastRow,
  now: Date,
  limitsCache: Map<string, BroadcastLimits>,
  result: DrainResult,
): Promise<void> {
  const limits = await loadLimits(db, broadcast.account_id, limitsCache)

  // §11.3 — fora da janela: dorme até a próxima abertura.
  if (!isWithinSendWindow(now, limits)) {
    await db
      .from('broadcasts')
      .update({ next_send_at: nextWindowStart(now, limits).toISOString() })
      .eq('id', broadcast.id)
    result.slept++
    return
  }

  // §11.2 — teto nas últimas 24h: reavalia daqui a 1h.
  if ((await sentInLast24h(db, broadcast.account_id, now)) >= limits.daily_cap) {
    await db
      .from('broadcasts')
      .update({ next_send_at: new Date(now.getTime() + 60 * 60_000).toISOString() })
      .eq('id', broadcast.id)
    result.slept++
    return
  }

  const { data: recipients } = await db
    .from('broadcast_recipients')
    .select('id, contact_id, contacts(id, name, phone)')
    .eq('broadcast_id', broadcast.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)

  const recipient = recipients?.[0] as
    | {
        id: string
        contact_id: string | null
        contacts:
          | { id: string; name: string | null; phone: string | null }
          | { id: string; name: string | null; phone: string | null }[]
          | null
      }
    | undefined

  // Sem pendentes: finaliza. 'failed' só quando NADA saiu.
  if (!recipient) {
    const { data: fresh } = await db
      .from('broadcasts')
      .select('sent_count, failed_count')
      .eq('id', broadcast.id)
      .single()
    const finalStatus =
      (fresh?.sent_count ?? 0) === 0 && (fresh?.failed_count ?? 0) > 0
        ? 'failed'
        : 'sent'
    await db
      .from('broadcasts')
      .update({ status: finalStatus, next_send_at: null })
      .eq('id', broadcast.id)
    result.finished++
    return
  }

  const contact = Array.isArray(recipient.contacts)
    ? recipient.contacts[0]
    : recipient.contacts

  const failRecipient = async (message: string) => {
    await db
      .from('broadcast_recipients')
      .update({ status: 'failed', error_message: message })
      .eq('id', recipient.id)
    // Segue direto para o próximo destinatário no próximo tick — pular
    // um contato inválido não é um envio, então não gasta o jitter.
    await db
      .from('broadcasts')
      .update({ next_send_at: now.toISOString() })
      .eq('id', broadcast.id)
    result.failed++
  }

  if (!contact?.phone) {
    await failRecipient('Contato removido ou sem telefone')
    return
  }
  if (await isOptedOut(db, contact.id)) {
    await failRecipient(`Contato pediu para não receber (tag ${OPTOUT_TAG})`)
    return
  }

  const text = renderBroadcastMessage(broadcast.message_text, contact)
  const config = await loadSendConfig(db, broadcast.account_id)

  let messageId: string | null = null
  let lastError = ''
  for (const variant of phoneVariants(sanitizePhoneForMeta(contact.phone))) {
    try {
      messageId = await transportSend(config, variant, { type: 'text', text })
      break
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      if (!isVariantRetryableError(config, lastError)) break
    }
  }

  if (messageId) {
    await db
      .from('broadcast_recipients')
      .update({
        status: 'sent',
        sent_at: now.toISOString(),
        whatsapp_message_id: messageId,
      })
      .eq('id', recipient.id)
    result.sent++
  } else {
    await db
      .from('broadcast_recipients')
      .update({ status: 'failed', error_message: lastError || 'Falha no envio' })
      .eq('id', recipient.id)
    result.failed++
  }

  // §11.1 — jitter mesmo após falha de envio real: o ritmo é o que
  // protege o número, não o resultado individual.
  await db
    .from('broadcasts')
    .update({
      next_send_at: new Date(now.getTime() + jitterDelayMs(limits)).toISOString(),
    })
    .eq('id', broadcast.id)
}
