/**
 * Foto de perfil do WhatsApp nos contatos.
 *
 * A Evolution devolve a URL da foto (CDN do WhatsApp), mas essa URL
 * expira — então o fluxo certo é: buscar a URL → baixar os bytes →
 * guardar no bucket chat-media (path estável) → salvar a URL pública
 * do bucket em contacts.avatar_url. Roda fire-and-forget a partir do
 * webhook (contato novo ou sem foto) e do backfill.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { fetchProfilePictureUrl } from './evolution-api'
import { readEvolutionEnv } from './evolution-config'

let _admin: SupabaseClient | null = null
function admin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  if (!_admin) _admin = createClient(url, key)
  return _admin
}

export interface SyncAvatarArgs {
  contactId: string
  accountId: string
  /** Dígitos do telefone (sem +). */
  phone: string
  instanceName: string
}

/**
 * Busca e persiste a foto de perfil de UM contato. Silencioso em erro
 * (foto é cosmético — nunca pode derrubar o webhook). Retorna a URL
 * pública gravada, ou null quando o número não tem foto visível.
 */
export async function syncContactAvatar(
  args: SyncAvatarArgs,
): Promise<string | null> {
  try {
    const db = admin()
    const env = readEvolutionEnv()
    if (!db || !env) return null

    const pictureUrl = await fetchProfilePictureUrl({
      baseUrl: env.baseUrl,
      apikey: env.globalApikey,
      instanceName: args.instanceName,
      number: args.phone,
    })
    if (!pictureUrl) return null

    const imageRes = await fetch(pictureUrl)
    if (!imageRes.ok) return null
    const bytes = Buffer.from(await imageRes.arrayBuffer())
    const contentType = imageRes.headers.get('content-type') ?? 'image/jpeg'

    // Path estável por contato — re-sync sobrescreve em vez de acumular.
    const path = `account-${args.accountId}/avatars/${args.contactId}.jpg`
    const { error: uploadError } = await db.storage
      .from('chat-media')
      .upload(path, bytes, { contentType, upsert: true })
    if (uploadError) {
      console.error('[avatar-sync] upload failed:', uploadError.message)
      return null
    }

    const { data: pub } = db.storage.from('chat-media').getPublicUrl(path)
    const publicUrl = pub?.publicUrl
    if (!publicUrl) return null

    await db
      .from('contacts')
      .update({ avatar_url: publicUrl, updated_at: new Date().toISOString() })
      .eq('id', args.contactId)

    return publicUrl
  } catch (err) {
    console.error('[avatar-sync] failed:', err)
    return null
  }
}
