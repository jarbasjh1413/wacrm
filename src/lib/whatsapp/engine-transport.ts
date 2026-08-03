import { decrypt } from '@/lib/whatsapp/encryption'
import {
  sendTextMessage as metaSendText,
  sendTemplateMessage as metaSendTemplate,
  sendMediaMessage as metaSendMedia,
  sendInteractiveButtons as metaSendButtons,
  sendInteractiveList as metaSendList,
  sendReactionMessage as metaSendReaction,
  type InteractiveButton,
  type InteractiveListSection,
  type MediaKind,
} from '@/lib/whatsapp/meta-api'
import {
  sendTextMessage as evoSendText,
  sendMediaMessage as evoSendMedia,
  sendInteractiveButtons as evoSendButtons,
  sendInteractiveList as evoSendList,
  sendReactionMessage as evoSendReaction,
  type EvolutionConn,
} from '@/lib/whatsapp/evolution-api'
import {
  isRecipientNotAllowedError,
  isNumberNotOnWhatsAppError,
} from '@/lib/whatsapp/phone-utils'

// ------------------------------------------------------------
// Engine-agnostic outbound transport.
//
// The automations engine, the Flows runner and the AI auto-reply all
// need to push a WhatsApp message through "whatever number this
// account/conversation uses" without caring whether that's Meta Cloud
// API or Evolution. This module owns:
//   1. picking the right whatsapp_config row (pinned → default → first),
//   2. decrypting the engine credentials,
//   3. dispatching the message shape to the right API client.
// Callers keep their own DB persistence and phone-variant retry loop
// (using isVariantRetryableError for the engine-correct signal).
// ------------------------------------------------------------

// Service-role and session Supabase clients both fit this shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SendConfigRow = any

/**
 * Resolve the whatsapp_config row a send should use. Post-037 an
 * account may own several rows (one per number): prefer the instance
 * the conversation is pinned to, then the account default, then the
 * oldest row (legacy single-number accounts).
 */
export async function loadSendConfig(
  db: AnyDb,
  accountId: string,
  conversationId?: string
): Promise<SendConfigRow> {
  let pinnedId: string | null = null
  if (conversationId) {
    const { data } = await db
      .from('conversations')
      .select('whatsapp_config_id')
      .eq('id', conversationId)
      .maybeSingle()
    pinnedId = data?.whatsapp_config_id ?? null
  }

  const { data: configs, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
  if (error || !configs || configs.length === 0) {
    throw new Error('WhatsApp not configured for this account')
  }
  return (
    configs.find((c: SendConfigRow) => c.id === pinnedId) ??
    configs.find((c: SendConfigRow) => c.is_default) ??
    configs[0]
  )
}

export type TransportMessage =
  | { type: 'text'; text: string }
  | { type: 'media'; kind: MediaKind; link: string; caption?: string; filename?: string }
  | { type: 'template'; templateName: string; language?: string; params?: string[] }
  | {
      type: 'buttons'
      bodyText: string
      buttons: InteractiveButton[]
      headerText?: string
      footerText?: string
    }
  | {
      type: 'list'
      bodyText: string
      buttonLabel: string
      sections: InteractiveListSection[]
      headerText?: string
      footerText?: string
    }
  | {
      type: 'reaction'
      /** Engine id of the message being reacted to. */
      targetMessageId: string
      /** Whether we sent the target message (Evolution needs this). */
      targetFromMe: boolean
      /** Empty string removes the reaction. */
      emoji: string
    }

function evolutionConnFromConfig(config: SendConfigRow): EvolutionConn {
  const baseUrl =
    (config.evolution_base_url as string) || process.env.EVOLUTION_BASE_URL
  const instanceName = config.evolution_instance_name as string
  if (!baseUrl || !instanceName) {
    throw new Error('This WhatsApp number is missing its Evolution connection details')
  }
  let apikey = ''
  try {
    apikey = decrypt(config.evolution_apikey)
  } catch {
    apikey = process.env.EVOLUTION_GLOBAL_APIKEY ?? ''
  }
  if (!apikey) {
    throw new Error('This WhatsApp number has no usable Evolution apikey')
  }
  return { baseUrl, instanceName, apikey }
}

/**
 * Send one message through the config row's engine. Returns the
 * engine-native message id (wamid for Meta, Baileys key id for
 * Evolution) — both are persisted in messages.message_id.
 */
export async function transportSend(
  config: SendConfigRow,
  to: string,
  msg: TransportMessage
): Promise<string> {
  if (config.engine === 'evolution') {
    const conn = evolutionConnFromConfig(config)
    switch (msg.type) {
      case 'text':
        return (await evoSendText({ ...conn, to, text: msg.text })).messageId
      case 'media':
        return (
          await evoSendMedia({
            ...conn,
            to,
            kind: msg.kind,
            link: msg.link,
            caption: msg.caption,
            filename: msg.filename,
          })
        ).messageId
      case 'buttons':
        return (
          await evoSendButtons({
            ...conn,
            to,
            bodyText: msg.bodyText,
            buttons: msg.buttons,
            headerText: msg.headerText,
            footerText: msg.footerText,
          })
        ).messageId
      case 'list':
        return (
          await evoSendList({
            ...conn,
            to,
            bodyText: msg.bodyText,
            buttonLabel: msg.buttonLabel,
            sections: msg.sections,
            headerText: msg.headerText,
            footerText: msg.footerText,
          })
        ).messageId
      case 'reaction':
        return (
          await evoSendReaction({
            ...conn,
            to,
            targetMessageId: msg.targetMessageId,
            targetFromMe: msg.targetFromMe,
            emoji: msg.emoji,
          })
        ).messageId
      case 'template':
        // Approved templates are a Meta-only concept (CLAUDE.md §6.5).
        throw new Error(
          'Template messages are not supported on this WhatsApp number (Evolution engine). Use a regular message.'
        )
    }
  }

  const accessToken = decrypt(config.access_token)
  switch (msg.type) {
    case 'text':
      return (
        await metaSendText({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to,
          text: msg.text,
        })
      ).messageId
    case 'media':
      return (
        await metaSendMedia({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to,
          kind: msg.kind,
          link: msg.link,
          caption: msg.caption,
          filename: msg.filename,
        })
      ).messageId
    case 'buttons':
      return (
        await metaSendButtons({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to,
          bodyText: msg.bodyText,
          buttons: msg.buttons,
          headerText: msg.headerText,
          footerText: msg.footerText,
        })
      ).messageId
    case 'list':
      return (
        await metaSendList({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to,
          bodyText: msg.bodyText,
          buttonLabel: msg.buttonLabel,
          sections: msg.sections,
          headerText: msg.headerText,
          footerText: msg.footerText,
        })
      ).messageId
    case 'reaction':
      return (
        await metaSendReaction({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to,
          targetMessageId: msg.targetMessageId,
          emoji: msg.emoji,
        })
      ).messageId
    case 'template':
      return (
        await metaSendTemplate({
          phoneNumberId: config.phone_number_id,
          accessToken,
          to,
          templateName: msg.templateName,
          language: msg.language,
          params: msg.params,
        })
      ).messageId
  }
}

/**
 * Engine-correct "this exact number failed, but a phone variant might
 * work" signal for the callers' retry loops. Meta: sandbox allow-list
 * (#131030). Evolution: number has no WhatsApp account (Brazilian
 * ninth-digit mismatches surface this way).
 */
export function isVariantRetryableError(
  config: SendConfigRow,
  message: string
): boolean {
  return config.engine === 'evolution'
    ? isNumberNotOnWhatsAppError(message)
    : isRecipientNotAllowedError(message)
}
