import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { syncContactAvatar } from '@/lib/whatsapp/avatar-sync'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import {
  applyOptOutIfRequested,
  flagBroadcastReplyIfAny,
} from '@/lib/whatsapp/broadcast-inbound'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getMediaBase64 } from '@/lib/whatsapp/evolution-api'

/**
 * Evolution API webhook (unofficial WhatsApp engine).
 *
 * Evolution posts one event per call (webhook_by_events=false):
 *   { event, instance, data, ... }
 *
 * Events handled (see WEBHOOK_EVENTS in evolution-api.ts):
 *   messages.upsert    — inbound (and phone-sent outbound) messages
 *   messages.update    — delivery/read status ticks
 *   connection.update  — instance connected / disconnected
 *   qrcode.updated     — ignored (QR is fetched on demand in Settings)
 *
 * Auth: shared secret in the `x-evolution-secret` header. We configure
 * Evolution to send it when creating the instance/webhook (Evolution
 * supports per-webhook headers). Fail-closed like the Meta HMAC check:
 * if EVOLUTION_WEBHOOK_SECRET is unset, every request is rejected.
 *
 * Mirrors the Meta webhook's structure (webhook/route.ts): respond 200
 * immediately, process inside after(). Tenancy is resolved by instance
 * name -> whatsapp_config row (engine='evolution').
 */

export const maxDuration = 60

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

// ============================================================
// Evolution payload shapes (defensive: v2.x variations included)
// ============================================================

interface EvolutionMessageKey {
  remoteJid?: string
  fromMe?: boolean
  id?: string
  participant?: string
  /** Quando o chat usa LID (número oculto), o JID real vem aqui (055+). */
  remoteJidAlt?: string
  addressingMode?: string
}

interface EvolutionMessageData {
  key?: EvolutionMessageKey
  pushName?: string
  messageType?: string
  messageTimestamp?: number
  message?: {
    conversation?: string
    extendedTextMessage?: { text?: string }
    imageMessage?: { caption?: string; mimetype?: string }
    videoMessage?: { caption?: string; mimetype?: string }
    documentMessage?: { caption?: string; mimetype?: string; fileName?: string }
    audioMessage?: { mimetype?: string }
    /** Transcrição do speechToText da Evolution (055), quando ligado. */
    speechToText?: string
    stickerMessage?: { mimetype?: string }
    locationMessage?: {
      degreesLatitude?: number
      degreesLongitude?: number
      name?: string
      address?: string
    }
    reactionMessage?: { key?: EvolutionMessageKey; text?: string }
    /** Present when the webhook is configured with base64=true. */
    base64?: string
  }
  contextInfo?: { stanzaId?: string; quotedMessage?: unknown }
}

interface EvolutionStatusData {
  keyId?: string
  key?: EvolutionMessageKey
  messageId?: string
  remoteJid?: string
  fromMe?: boolean
  status?: string
}

interface EvolutionConnectionData {
  state?: string
  statusReason?: number
}

interface EvolutionWebhookBody {
  event?: string
  instance?: string
  data?: unknown
}

// ============================================================
// Route handlers
// ============================================================

export async function POST(request: Request) {
  const secret = process.env.EVOLUTION_WEBHOOK_SECRET
  const presented = request.headers.get('x-evolution-secret')
  // Fail-closed: no configured secret means no accepted webhooks.
  if (!secret || !presented || presented !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: EvolutionWebhookBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Respond 200 immediately; process within after() so a slow database
  // or automation never makes Evolution retry (same rationale as the
  // Meta webhook, issue #301).
  after(async () => {
    try {
      await processEvent(body)
    } catch (error) {
      console.error('[evolution-webhook] processing error:', error)
    }
  })

  return NextResponse.json({ received: true })
}

async function processEvent(body: EvolutionWebhookBody) {
  const event = (body.event ?? '').toLowerCase()
  const instanceName = body.instance
  if (!event || !instanceName) return

  // Resolve tenancy: instance name -> whatsapp_config row. Unknown
  // instances are dropped with a log (mirrors Meta's phone_number_id
  // routing).
  const { data: configs, error: configError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('*')
    .eq('engine', 'evolution')
    .eq('evolution_instance_name', instanceName)

  if (configError) {
    console.error('[evolution-webhook] config lookup failed:', configError)
    return
  }
  if (!configs || configs.length !== 1) {
    console.warn(
      `[evolution-webhook] dropping event for unknown instance "${instanceName}" (matches: ${configs?.length ?? 0})`
    )
    return
  }
  const config = configs[0]

  switch (event) {
    case 'messages.upsert':
      await handleMessageUpsert(config, body.data as EvolutionMessageData)
      break
    case 'messages.update':
      await handleStatusUpdate(config, body.data)
      break
    case 'connection.update':
      await handleConnectionUpdate(config, body.data as EvolutionConnectionData)
      break
    default:
      // qrcode.updated and anything else: intentionally ignored.
      break
  }
}

// ============================================================
// messages.upsert — inbound (and phone-sent outbound) messages
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConfigRow = any

async function handleMessageUpsert(config: ConfigRow, data: EvolutionMessageData) {
  if (!data?.key?.remoteJid || !data.key.id) return

  // O WhatsApp vem migrando contatos para o formato LID (número oculto):
  // remoteJid chega como "1312...@lid" e o JID de telefone real vem em
  // remoteJidAlt. Sem esta tradução, mensagens de clientes LID eram
  // DESCARTADAS em silêncio — o CRM ficava surdo só para eles.
  let remoteJid = data.key.remoteJid
  if (remoteJid.endsWith('@lid')) {
    const alt = data.key.remoteJidAlt
    if (alt?.endsWith('@s.whatsapp.net')) {
      remoteJid = alt
    } else {
      console.warn(`[evolution-webhook] LID sem remoteJidAlt — mensagem pulada (${remoteJid})`)
      return
    }
  }
  // Group and broadcast chats are out of scope (the CRM is 1:1).
  if (!remoteJid.endsWith('@s.whatsapp.net')) return

  const phone = normalizePhone(remoteJid.split('@')[0])
  if (!phone) return

  const fromMe = data.key.fromMe === true
  // pushName is the customer's WhatsApp display name — only meaningful
  // on inbound. For fromMe echoes we must NOT rename the contact.
  const contactName = fromMe ? '' : (data.pushName ?? '')

  const contactOutcome = await findOrCreateContact(
    config.account_id,
    config.user_id,
    phone,
    contactName
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  // Foto de perfil do WhatsApp — cosmético e fire-and-forget: contato
  // novo (ou ainda sem foto) dispara a busca em segundo plano; nunca
  // atrasa nem derruba o processamento da mensagem.
  if (!contactRecord.avatar_url && config.evolution_instance_name) {
    void syncContactAvatar({
      contactId: contactRecord.id,
      accountId: config.account_id,
      phone,
      instanceName: config.evolution_instance_name,
    })
  }

  const convResult = await findOrCreateConversation(
    config.account_id,
    config.user_id,
    contactRecord.id,
    config.id
  )
  if (!convResult) return
  const conversation = convResult.conversation

  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), config.account_id, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  // Reactions short-circuit — they aren't messages (mirrors Meta path).
  if (data.message?.reactionMessage) {
    await handleReaction(data, conversation.id, contactRecord.id, fromMe)
    return
  }

  const { contentText, contentType, media } = parseMessageContent(data)

  // Persist media bytes to the chat-media bucket. Best-effort: any
  // failure keeps the message with its typed placeholder instead of
  // dropping the delivery.
  let mediaUrl: string | null = null
  if (media) {
    try {
      mediaUrl = await persistInboundMedia(config, data, media)
    } catch (error) {
      console.error('[evolution-webhook] media persist failed:', error)
    }
  }

  // Swipe-reply context: Evolution carries the quoted message id in
  // contextInfo.stanzaId. Missing parent -> NULL, UI renders unquoted.
  let replyToInternalId: string | null = null
  const stanzaId = data.contextInfo?.stanzaId
  if (stanzaId) {
    replyToInternalId = await lookupInternalIdByEngineId(stanzaId, conversation.id)
  }

  // Deduplicate: Evolution can re-deliver messages.upsert on reconnect.
  // message_id carries the engine id in both engines, so an existing row
  // means this delivery was already processed.
  const { data: existing } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('conversation_id', conversation.id)
    .eq('message_id', data.key.id)
    .limit(1)
  if (existing && existing.length > 0) return

  const isFirstInboundMessage = fromMe
    ? false
    : await (async () => {
        const { count } = await supabaseAdmin()
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('conversation_id', conversation.id)
          .eq('sender_type', 'customer')
        return (count ?? 0) === 0
      })()

  const timestampMs = data.messageTimestamp
    ? Number(data.messageTimestamp) * 1000
    : Date.now()

  // fromMe=true means the number's owner sent this from the phone (or
  // another WhatsApp Web session). Record it as an agent message so the
  // CRM thread mirrors the real conversation — that's the WA Scale
  // replacement promise. status 'sent' (ticks will upgrade it).
  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: fromMe ? 'agent' : 'customer',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: data.key.id,
    status: fromMe ? 'sent' : 'delivered',
    created_at: new Date(timestampMs).toISOString(),
    reply_to_message_id: replyToInternalId,
  })
  if (msgError) {
    console.error('[evolution-webhook] message insert failed:', msgError)
    return
  }

  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${contentType}]`,
      last_message_at: new Date().toISOString(),
      unread_count: fromMe ? conversation.unread_count || 0 : (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
      // Adopt the instance for threads that predate multi-number.
      whatsapp_config_id: conversation.whatsapp_config_id ?? config.id,
    })
    .eq('id', conversation.id)
  if (convError) {
    console.error('[evolution-webhook] conversation update failed:', convError)
  }

  // Phone-sent echoes stop here: no automations, no AI, no public
  // webhook event — the agent talking is not a trigger.
  if (fromMe) return

  // Automation triggers, mirroring the Meta webhook (flows/AI dispatch
  // intentionally deferred to a later Fase 1 step).
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = ['new_message_received', 'keyword_match']
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId: config.account_id,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: contentText ?? '',
        conversation_id: conversation.id,
      },
    }).catch((err: unknown) =>
      console.error('[evolution-webhook] automations dispatch failed:', err)
    )
  }

  // Broadcasts: marca 'replied' se este contato estava num disparo sem
  // resposta, e aplica o opt-out (§11.5) se a mensagem for "parar"/"sair".
  await flagBroadcastReplyIfAny(supabaseAdmin(), config.account_id, contactRecord.id)
  const optedOut = await applyOptOutIfRequested(
    supabaseAdmin(),
    config.account_id,
    contactRecord.id,
    contentText,
  )
  if (optedOut) {
    console.log(
      `[evolution-webhook] contato ${contactRecord.id} pediu opt-out — tag aplicada`
    )
  }

  await dispatchWebhookEvent(supabaseAdmin(), config.account_id, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: data.key.id,
    content_type: contentType,
    text: contentText,
  })
}

interface InboundMediaInfo {
  mimeType?: string
  fileName?: string
}

/**
 * Map an Evolution message payload to the CRM's (content_text,
 * content_type) pair, plus a media descriptor when the message carries
 * a downloadable body. content_type must satisfy the messages CHECK
 * constraint: text, image, document, audio, video, location, template,
 * interactive.
 */
function parseMessageContent(data: EvolutionMessageData): {
  contentText: string | null
  contentType: string
  media: InboundMediaInfo | null
} {
  const m = data.message
  if (!m) {
    return { contentText: '[Unsupported message]', contentType: 'text', media: null }
  }

  const text = m.conversation ?? m.extendedTextMessage?.text
  if (text) return { contentText: text, contentType: 'text', media: null }

  // Media without caption stores content_text = null — the bubble
  // renders just the media (no "[Image]" text underneath, matching
  // WhatsApp) and the conversation-list preview falls back to the
  // typed placeholder at the conversation-update site.
  if (m.imageMessage) {
    return {
      contentText: m.imageMessage.caption ?? null,
      contentType: 'image',
      media: { mimeType: m.imageMessage.mimetype },
    }
  }
  if (m.videoMessage) {
    return {
      contentText: m.videoMessage.caption ?? null,
      contentType: 'video',
      media: { mimeType: m.videoMessage.mimetype },
    }
  }
  if (m.documentMessage) {
    return {
      contentText: m.documentMessage.fileName ?? m.documentMessage.caption ?? '[Document]',
      contentType: 'document',
      media: {
        mimeType: m.documentMessage.mimetype,
        fileName: m.documentMessage.fileName,
      },
    }
  }
  if (m.audioMessage) {
    // Com o speechToText ligado (055) a Evolution manda a transcrição
    // junto. Guardar como texto do áudio faz o Radar e o histórico da IA
    // enxergarem o que foi FALADO — antes o áudio era invisível para eles.
    const transcricao = m.speechToText?.trim()
    return {
      contentText: transcricao ? transcricao : null,
      contentType: 'audio',
      media: { mimeType: m.audioMessage.mimetype },
    }
  }
  if (m.stickerMessage) {
    return {
      contentText: null,
      contentType: 'image',
      media: { mimeType: m.stickerMessage.mimetype },
    }
  }
  if (m.locationMessage) {
    const loc = m.locationMessage
    const parts = [
      loc.name,
      loc.address,
      loc.degreesLatitude != null && loc.degreesLongitude != null
        ? `${loc.degreesLatitude},${loc.degreesLongitude}`
        : null,
    ].filter(Boolean)
    return {
      contentText: parts.join(' — ') || '[Location]',
      contentType: 'location',
      media: null,
    }
  }

  return {
    contentText: `[${data.messageType ?? 'Unsupported message'}]`,
    contentType: 'text',
    media: null,
  }
}

// ============================================================
// Inbound media → chat-media bucket (migration 023)
// ============================================================

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'application/pdf': 'pdf',
}

function extensionFor(mimeType: string | undefined, fileName: string | undefined): string {
  const fromName = fileName?.includes('.') ? fileName.split('.').pop() : undefined
  if (fromName && /^[a-z0-9]{1,8}$/i.test(fromName)) return fromName.toLowerCase()
  if (!mimeType) return 'bin'
  const clean = mimeType.split(';')[0].trim().toLowerCase()
  return MIME_EXTENSIONS[clean] ?? clean.split('/')[1]?.slice(0, 8) ?? 'bin'
}

/**
 * Fetch the media bytes and store them in the public chat-media bucket,
 * returning the public URL to persist on the message row.
 *
 * Bytes come from the webhook itself when Evolution is configured with
 * base64=true (data.message.base64); otherwise we fall back to the
 * getBase64FromMediaMessage endpoint using the instance's stored apikey.
 * Path convention mirrors migration 023:
 *   account-<account_id>/evolution/<timestamp>-<engine message id>.<ext>
 */
async function persistInboundMedia(
  config: ConfigRow,
  data: EvolutionMessageData,
  media: InboundMediaInfo
): Promise<string | null> {
  let base64 = data.message?.base64 ?? null
  let mimeType = media.mimeType
  let fileName = media.fileName

  if (!base64) {
    const baseUrl =
      (config.evolution_base_url as string) || process.env.EVOLUTION_BASE_URL
    if (!baseUrl || !config.evolution_instance_name || !data.key?.id) return null
    let apikey = ''
    try {
      apikey = decrypt(config.evolution_apikey)
    } catch {
      apikey = process.env.EVOLUTION_GLOBAL_APIKEY ?? ''
    }
    if (!apikey) return null

    const fetched = await getMediaBase64({
      baseUrl,
      instanceName: config.evolution_instance_name,
      apikey,
      messageId: data.key.id,
    })
    base64 = fetched.base64
    mimeType = fetched.mimeType ?? mimeType
    fileName = fetched.fileName ?? fileName
  }

  // Some payloads prefix a data URL; the storage client wants raw bytes.
  const commaIdx = base64.indexOf(',')
  if (base64.startsWith('data:') && commaIdx !== -1) {
    base64 = base64.slice(commaIdx + 1)
  }
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length === 0) return null

  const ext = extensionFor(mimeType, fileName)
  const path = `account-${config.account_id}/evolution/${Date.now()}-${data.key?.id ?? 'media'}.${ext}`

  const { error: uploadError } = await supabaseAdmin()
    .storage.from('chat-media')
    .upload(path, buffer, {
      contentType: mimeType?.split(';')[0].trim() || 'application/octet-stream',
      upsert: true,
    })
  if (uploadError) {
    console.error('[evolution-webhook] storage upload failed:', uploadError)
    return null
  }

  const { data: publicUrl } = supabaseAdmin()
    .storage.from('chat-media')
    .getPublicUrl(path)
  return publicUrl?.publicUrl ?? null
}

async function handleReaction(
  data: EvolutionMessageData,
  conversationId: string,
  contactId: string,
  fromMe: boolean
) {
  const reaction = data.message?.reactionMessage
  if (!reaction?.key?.id) return
  // Agent reactions from the phone are ignored — the CRM only tracks
  // customer reactions plus reactions made in the CRM UI.
  if (fromMe) return

  const targetInternalId = await lookupInternalIdByEngineId(reaction.key.id, conversationId)
  if (!targetInternalId) return

  // Empty emoji = removal (same semantics as the Meta engine).
  const emoji = reaction.text ?? ''
  if (!emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[evolution-webhook] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[evolution-webhook] reaction upsert failed:', upsertError.message)
  }
}

async function lookupInternalIdByEngineId(
  engineMessageId: string,
  conversationId: string
): Promise<string | null> {
  const { data } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', engineMessageId)
    .eq('conversation_id', conversationId)
    .limit(1)
  return data && data.length > 0 ? data[0].id : null
}

// ============================================================
// messages.update — delivery/read ticks
// ============================================================

const STATUS_MAP: Record<string, string> = {
  SERVER_ACK: 'sent',
  DELIVERY_ACK: 'delivered',
  READ: 'read',
  PLAYED: 'read',
  ERROR: 'failed',
}

const STATUS_LADDER = ['pending', 'sent', 'delivered', 'read']

async function handleStatusUpdate(config: ConfigRow, rawData: unknown) {
  // Evolution v2 posts either a single object or an array of updates.
  const updates: EvolutionStatusData[] = Array.isArray(rawData)
    ? rawData
    : rawData
      ? [rawData as EvolutionStatusData]
      : []

  for (const update of updates) {
    const engineId = update.keyId ?? update.key?.id ?? update.messageId
    const mapped = update.status ? STATUS_MAP[update.status.toUpperCase()] : undefined
    if (!engineId || !mapped) continue

    // Never move a status backwards (a late DELIVERY_ACK after READ).
    const { data: rows } = await supabaseAdmin()
      .from('messages')
      .select('id, status')
      .eq('message_id', engineId)
      .limit(1)
    if (!rows || rows.length === 0) continue
    const current = rows[0].status as string
    const currentRank = STATUS_LADDER.indexOf(current)
    const nextRank = STATUS_LADDER.indexOf(mapped)
    if (mapped !== 'failed' && nextRank !== -1 && currentRank >= nextRank) continue

    await supabaseAdmin()
      .from('messages')
      .update({ status: mapped })
      .eq('id', rows[0].id)

    // Espelha nos destinatários de broadcast (fila evolution grava o
    // Baileys key id em whatsapp_message_id). Mesma escada forward-only;
    // o trigger de agregação atualiza os contadores do broadcast pai.
    const { data: recipient } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status')
      .eq('whatsapp_message_id', engineId)
      .maybeSingle()
    if (recipient) {
      const recRank = STATUS_LADDER.indexOf(recipient.status as string)
      const mappedRank = STATUS_LADDER.indexOf(mapped)
      const failedFromEarly =
        mapped === 'failed' && ['pending', 'sent'].includes(recipient.status as string)
      if (failedFromEarly || (mappedRank !== -1 && mappedRank > recRank)) {
        const update: Record<string, unknown> = { status: mapped }
        const nowIso = new Date().toISOString()
        if (mapped === 'delivered') update.delivered_at = nowIso
        if (mapped === 'read') update.read_at = nowIso
        await supabaseAdmin()
          .from('broadcast_recipients')
          .update(update)
          .eq('id', recipient.id)
      }
    }

    await dispatchWebhookEvent(supabaseAdmin(), config.account_id, 'message.status_updated', {
      whatsapp_message_id: engineId,
      status: mapped,
    })
  }
}

// ============================================================
// connection.update — instance connected / dropped
// ============================================================

async function handleConnectionUpdate(config: ConfigRow, data: EvolutionConnectionData) {
  const state = data?.state
  if (!state) return

  const connected = state === 'open'
  const { error } = await supabaseAdmin()
    .from('whatsapp_config')
    .update({
      status: connected ? 'connected' : 'disconnected',
      ...(connected ? { connected_at: new Date().toISOString() } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', config.id)
  if (error) {
    console.error('[evolution-webhook] connection status update failed:', error)
  }
  // Anti-ban rule 7 (CLAUDE.md §11): surface drops. Notification UI
  // wiring lands with the Settings screen; the log keeps a trail now.
  if (!connected) {
    console.warn(
      `[evolution-webhook] instance "${config.evolution_instance_name}" disconnected (state=${state}, reason=${data.statusReason ?? 'n/a'})`
    )
  }
}

// ============================================================
// Shared find-or-create helpers (mirrors webhook/route.ts semantics;
// duplicated deliberately — the Meta route is scheduled for removal
// in Fase 1 item 5, so we don't refactor it now)
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  wasCreated: boolean
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  const existingContact = await findExistingContact(supabaseAdmin(), accountId, phone)

  if (existingContact) {
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('[evolution-webhook] contact create failed:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
  whatsappConfigId: string
) {
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('[evolution-webhook] conversation lookup failed:', findError)
    return null
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
      whatsapp_config_id: whatsappConfigId,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('[evolution-webhook] conversation create failed:', createError)
    return null
  }

  return { conversation: newConv, created: true }
}
