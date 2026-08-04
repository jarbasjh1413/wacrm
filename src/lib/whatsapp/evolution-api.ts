/**
 * Evolution API helpers (unofficial WhatsApp via Baileys).
 *
 * Mirrors the meta-api.ts contract: every function takes a single options
 * object (named parameters) and send functions resolve to
 * `EvolutionSendResult` (`{ messageId }`), so call sites can swap engines
 * with minimal churn.
 *
 * Where Meta identifies a connection by `phoneNumberId + accessToken`,
 * Evolution identifies it by `baseUrl + instanceName + apikey`. Those three
 * fields travel together in `EvolutionConn` and are the first member of
 * every args interface.
 */

import { reportEvolutionSendOutcome } from './connection-health'

export interface EvolutionConn {
  /** e.g. https://evolution.oficinainformatica.tech (no trailing slash) */
  baseUrl: string
  /** Instance = one connected WhatsApp number */
  instanceName: string
  /** Global apikey, or the instance token returned by createInstance */
  apikey: string
}

export interface EvolutionSendResult {
  messageId: string
}

/** Shape of `key` in Evolution send responses and webhook payloads. */
interface EvolutionMessageKey {
  remoteJid?: string
  fromMe?: boolean
  id?: string
}

interface EvolutionSendResponse {
  key?: EvolutionMessageKey
  status?: string
}

interface EvolutionErrorResponse {
  status?: number
  error?: string
  response?: { message?: string | string[] }
  message?: string | string[]
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

async function throwEvolutionError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as EvolutionErrorResponse
    const detail = data.response?.message ?? data.message ?? data.error
    if (Array.isArray(detail)) message = detail.join('; ')
    else if (detail) message = detail
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}

async function evolutionFetch(
  conn: EvolutionConn,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<Response> {
  const url = `${normalizeBaseUrl(conn.baseUrl)}${path}`
  const response = await fetch(url, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: {
      apikey: conn.apikey,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })

  // Saúde da conexão: todo envio (paths /message/*) reporta o resultado
  // ao detector de socket zumbi. Fire-and-forget num clone da response
  // para não consumir o body que o chamador vai ler.
  if (path.startsWith('/message/')) {
    const instanceName = path.split('/').pop() ?? ''
    if (response.ok) {
      reportEvolutionSendOutcome(instanceName, true)
    } else {
      response
        .clone()
        .json()
        .then((data: EvolutionErrorResponse) => {
          const detail = data.response?.message ?? data.message ?? data.error
          const msg = Array.isArray(detail) ? detail.join('; ') : (detail ?? '')
          reportEvolutionSendOutcome(instanceName, false, String(msg))
        })
        .catch(() => reportEvolutionSendOutcome(instanceName, false, ''))
    }
  }

  return response
}

function toSendResult(data: EvolutionSendResponse, fallback: string): EvolutionSendResult {
  return { messageId: data.key?.id ?? fallback }
}

// ============================================================
// Instance management (create / QR / state / teardown)
// ============================================================

export interface CreateInstanceArgs extends EvolutionConn {
  /** Webhook Evolution should call for this instance's events. */
  webhookUrl?: string
  /** Extra headers Evolution sends on every webhook call (auth secret). */
  webhookHeaders?: Record<string, string>
}

export interface CreateInstanceResult {
  instanceName: string
  /** Per-instance token; store encrypted, can be used instead of the global key. */
  instanceToken?: string
  /** QR code as a data URL (base64 PNG), when immediately available. */
  qrBase64?: string
}

/**
 * Create a new instance (one WhatsApp number slot) using the Baileys
 * integration with QR-code pairing. Optionally wires the webhook in the
 * same call.
 */
export async function createInstance(args: CreateInstanceArgs): Promise<CreateInstanceResult> {
  const { webhookUrl, webhookHeaders, ...conn } = args
  const body: Record<string, unknown> = {
    instanceName: conn.instanceName,
    qrcode: true,
    integration: 'WHATSAPP-BAILEYS',
  }
  if (webhookUrl) {
    body.webhook = {
      url: webhookUrl,
      byEvents: false,
      base64: true,
      ...(webhookHeaders ? { headers: webhookHeaders } : {}),
      events: WEBHOOK_EVENTS,
    }
  }
  const response = await evolutionFetch(conn, '/instance/create', { body })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution API error: ${response.status}`)
  }
  const data = (await response.json()) as {
    instance?: { instanceName?: string }
    hash?: string | { apikey?: string }
    qrcode?: { base64?: string }
  }
  return {
    instanceName: data.instance?.instanceName ?? conn.instanceName,
    instanceToken: typeof data.hash === 'string' ? data.hash : data.hash?.apikey,
    qrBase64: data.qrcode?.base64,
  }
}

/** Events our webhook route understands (CLAUDE.md §6.2). */
export const WEBHOOK_EVENTS = [
  'QRCODE_UPDATED',
  'MESSAGES_UPSERT',
  'MESSAGES_UPDATE',
  'CONNECTION_UPDATE',
] as const

export interface ConnectInstanceResult {
  /** QR code as a data URL (base64 PNG) to render in Settings. */
  qrBase64?: string
  /** Raw pairing string (also encoded in the QR). */
  qrCode?: string
  /** Phone-pairing code, when Evolution offers it. */
  pairingCode?: string
}

/**
 * Ask for a fresh QR code. Call when the user opens the connect dialog or
 * the previous QR expired (they rotate every ~40s).
 */
export async function connectInstance(args: EvolutionConn): Promise<ConnectInstanceResult> {
  const response = await evolutionFetch(args, `/instance/connect/${args.instanceName}`)
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution API error: ${response.status}`)
  }
  const data = (await response.json()) as {
    base64?: string
    code?: string
    pairingCode?: string
  }
  return { qrBase64: data.base64, qrCode: data.code, pairingCode: data.pairingCode }
}

export type EvolutionConnectionState = 'open' | 'connecting' | 'close' | 'unknown'

/**
 * Current connection state of an instance.
 * `open` = number connected and ready to send/receive.
 */
export async function getConnectionState(args: EvolutionConn): Promise<EvolutionConnectionState> {
  const response = await evolutionFetch(args, `/instance/connectionState/${args.instanceName}`)
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution API error: ${response.status}`)
  }
  const data = (await response.json()) as { instance?: { state?: string } }
  const state = data.instance?.state
  return state === 'open' || state === 'connecting' || state === 'close' ? state : 'unknown'
}

export interface FetchedInstance {
  instanceName: string
  state: EvolutionConnectionState
  /** JID of the connected number, e.g. 5551999999999@s.whatsapp.net */
  ownerJid?: string
  profileName?: string
}

/** List every instance on the server (global apikey required). */
export async function fetchInstances(
  args: Omit<EvolutionConn, 'instanceName'>
): Promise<FetchedInstance[]> {
  const conn: EvolutionConn = { ...args, instanceName: '' }
  const response = await evolutionFetch(conn, '/instance/fetchInstances')
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution API error: ${response.status}`)
  }
  const data = (await response.json()) as Array<{
    // v2 flat shape
    name?: string
    connectionStatus?: string
    ownerJid?: string
    profileName?: string
    // v1-style nested shape, kept for compatibility
    instance?: {
      instanceName?: string
      status?: string
      owner?: string
      profileName?: string
    }
  }>
  return (Array.isArray(data) ? data : []).map((row) => {
    const state = row.connectionStatus ?? row.instance?.status
    return {
      instanceName: row.name ?? row.instance?.instanceName ?? '',
      state:
        state === 'open' || state === 'connecting' || state === 'close'
          ? state
          : 'unknown',
      ownerJid: row.ownerJid ?? row.instance?.owner,
      profileName: row.profileName ?? row.instance?.profileName,
    }
  })
}

/** Disconnect the WhatsApp session but keep the instance registered. */
export async function logoutInstance(args: EvolutionConn): Promise<void> {
  const response = await evolutionFetch(args, `/instance/logout/${args.instanceName}`, {
    method: 'DELETE',
  })
  if (!response.ok && response.status !== 404) {
    await throwEvolutionError(response, `Evolution API error: ${response.status}`)
  }
}

/** Remove the instance entirely. 404 is treated as already gone. */
export async function deleteInstance(args: EvolutionConn): Promise<void> {
  const response = await evolutionFetch(args, `/instance/delete/${args.instanceName}`, {
    method: 'DELETE',
  })
  if (!response.ok && response.status !== 404) {
    await throwEvolutionError(response, `Evolution API error: ${response.status}`)
  }
}

export interface SetInstanceWebhookArgs extends EvolutionConn {
  webhookUrl: string
  webhookHeaders?: Record<string, string>
}

/** Point (or re-point) an existing instance's webhook at our app. */
export async function setInstanceWebhook(args: SetInstanceWebhookArgs): Promise<void> {
  const { webhookUrl, webhookHeaders, ...conn } = args
  const response = await evolutionFetch(conn, `/webhook/set/${conn.instanceName}`, {
    body: {
      webhook: {
        enabled: true,
        url: webhookUrl,
        byEvents: false,
        base64: true,
        ...(webhookHeaders ? { headers: webhookHeaders } : {}),
        events: WEBHOOK_EVENTS,
      },
    },
  })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution API error: ${response.status}`)
  }
}

// ============================================================
// Sending — mirrors meta-api.ts signatures
// ============================================================

export interface SendTextArgs extends EvolutionConn {
  /** Digits only, country code included, e.g. 5551999999999 */
  to: string
  text: string
  /** Evolution message id to quote (reply). */
  contextMessageId?: string
  /** Milliseconds Evolution waits (shows "typing…") before sending. */
  delayMs?: number
}

/** Send a plain text message. */
export async function sendTextMessage(args: SendTextArgs): Promise<EvolutionSendResult> {
  const { to, text, contextMessageId, delayMs, ...conn } = args
  const body: Record<string, unknown> = { number: to, text }
  if (delayMs) body.delay = delayMs
  if (contextMessageId) body.quoted = { key: { id: contextMessageId } }
  const response = await evolutionFetch(conn, `/message/sendText/${conn.instanceName}`, { body })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution API error: ${response.status}`)
  }
  return toSendResult((await response.json()) as EvolutionSendResponse, '')
}

export type MediaKind = 'image' | 'video' | 'document' | 'audio'

export interface SendMediaArgs extends EvolutionConn {
  to: string
  kind: MediaKind
  /** Publicly reachable URL of the media file. */
  link: string
  caption?: string
  /** Only used for documents. */
  filename?: string
  contextMessageId?: string
  delayMs?: number
}

/**
 * Send a media message by URL. Audio uses Evolution's dedicated
 * voice-note endpoint (sendWhatsAppAudio) and ignores caption/filename,
 * matching the Meta engine's constraints.
 */
export async function sendMediaMessage(args: SendMediaArgs): Promise<EvolutionSendResult> {
  const { to, kind, link, caption, filename, contextMessageId, delayMs, ...conn } = args

  if (kind === 'audio') {
    const body: Record<string, unknown> = { number: to, audio: link }
    if (delayMs) body.delay = delayMs
    const response = await evolutionFetch(conn, `/message/sendWhatsAppAudio/${conn.instanceName}`, {
      body,
    })
    if (!response.ok) {
      await throwEvolutionError(response, `Evolution API error: ${response.status}`)
    }
    return toSendResult((await response.json()) as EvolutionSendResponse, '')
  }

  const body: Record<string, unknown> = {
    number: to,
    mediatype: kind,
    media: link,
  }
  if (caption) body.caption = caption
  if (kind === 'document' && filename) body.fileName = filename
  if (delayMs) body.delay = delayMs
  if (contextMessageId) body.quoted = { key: { id: contextMessageId } }
  const response = await evolutionFetch(conn, `/message/sendMedia/${conn.instanceName}`, { body })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution API error: ${response.status}`)
  }
  return toSendResult((await response.json()) as EvolutionSendResponse, '')
}

export interface SendReactionArgs extends EvolutionConn {
  to: string
  /** Evolution id of the message being reacted to. */
  targetMessageId: string
  /** Whether the target message was sent by us (fromMe). */
  targetFromMe: boolean
  /** Emoji to react with; empty string removes the reaction. */
  emoji: string
}

/** React to a message (empty emoji removes the reaction). */
export async function sendReactionMessage(args: SendReactionArgs): Promise<EvolutionSendResult> {
  const { to, targetMessageId, targetFromMe, emoji, ...conn } = args
  const response = await evolutionFetch(conn, `/message/sendReaction/${conn.instanceName}`, {
    body: {
      key: {
        remoteJid: `${to}@s.whatsapp.net`,
        fromMe: targetFromMe,
        id: targetMessageId,
      },
      reaction: emoji,
    },
  })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution API error: ${response.status}`)
  }
  return toSendResult((await response.json()) as EvolutionSendResponse, '')
}

// ============================================================
// Interactive messages (buttons / lists)
// ============================================================
//
// Baileys support for buttons and lists is historically unstable —
// WhatsApp mobile clients sometimes render them, sometimes silently
// drop them. Keep these as best-effort mirrors of the Meta versions;
// the UI may later hide interactive composing for Evolution instances.

export interface InteractiveButton {
  id: string
  title: string
}

export interface SendInteractiveButtonsArgs extends EvolutionConn {
  to: string
  bodyText: string
  headerText?: string
  footerText?: string
  buttons: InteractiveButton[]
  delayMs?: number
}

/** Send up to 3 reply buttons. */
export async function sendInteractiveButtons(
  args: SendInteractiveButtonsArgs
): Promise<EvolutionSendResult> {
  const { to, bodyText, headerText, footerText, buttons, delayMs, ...conn } = args
  const body: Record<string, unknown> = {
    number: to,
    title: headerText ?? '',
    description: bodyText,
    footer: footerText ?? '',
    buttons: buttons.map((b) => ({
      type: 'reply',
      displayText: b.title,
      id: b.id,
    })),
  }
  if (delayMs) body.delay = delayMs
  const response = await evolutionFetch(conn, `/message/sendButtons/${conn.instanceName}`, { body })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution API error: ${response.status}`)
  }
  return toSendResult((await response.json()) as EvolutionSendResponse, '')
}

export interface InteractiveListRow {
  id: string
  title: string
  description?: string
}

export interface InteractiveListSection {
  title?: string
  rows: InteractiveListRow[]
}

export interface SendInteractiveListArgs extends EvolutionConn {
  to: string
  bodyText: string
  buttonLabel: string
  headerText?: string
  footerText?: string
  sections: InteractiveListSection[]
  delayMs?: number
}

/** Send an expandable list message. */
export async function sendInteractiveList(
  args: SendInteractiveListArgs
): Promise<EvolutionSendResult> {
  const { to, bodyText, buttonLabel, headerText, footerText, sections, delayMs, ...conn } = args
  const body: Record<string, unknown> = {
    number: to,
    title: headerText ?? '',
    description: bodyText,
    buttonText: buttonLabel,
    footerText: footerText ?? '',
    sections: sections.map((s) => ({
      title: s.title ?? '',
      rows: s.rows.map((r) => ({
        title: r.title,
        description: r.description ?? '',
        rowId: r.id,
      })),
    })),
  }
  if (delayMs) body.delay = delayMs
  const response = await evolutionFetch(conn, `/message/sendList/${conn.instanceName}`, { body })
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution API error: ${response.status}`)
  }
  return toSendResult((await response.json()) as EvolutionSendResponse, '')
}

// ============================================================
// Incoming media
// ============================================================

export interface GetMediaBase64Args extends EvolutionConn {
  /** Evolution id of the message that carries the media. */
  messageId: string
  /** Convert short videos to mp4 (Evolution option). */
  convertToMp4?: boolean
}

export interface MediaBase64Result {
  /** Raw base64 (no data: prefix). */
  base64: string
  mimeType?: string
  fileName?: string
}

/**
 * Fetch the media bytes of a received message. Unlike Meta there is no
 * CDN URL — Evolution stores the encrypted blob and returns it as base64.
 * Callers should persist it (Supabase Storage, migration 023 chat_media)
 * instead of calling this repeatedly.
 */
export async function getMediaBase64(args: GetMediaBase64Args): Promise<MediaBase64Result> {
  const { messageId, convertToMp4, ...conn } = args
  const response = await evolutionFetch(
    conn,
    `/chat/getBase64FromMediaMessage/${conn.instanceName}`,
    {
      body: {
        message: { key: { id: messageId } },
        convertToMp4: convertToMp4 ?? false,
      },
    }
  )
  if (!response.ok) {
    await throwEvolutionError(response, `Evolution API error: ${response.status}`)
  }
  const data = (await response.json()) as {
    base64?: string
    mimetype?: string
    fileName?: string
  }
  if (!data.base64) {
    throw new Error('Evolution API returned no media content')
  }
  return { base64: data.base64, mimeType: data.mimetype, fileName: data.fileName }
}
