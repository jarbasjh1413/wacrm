/**
 * Detector de conexão travada da Evolution ("socket zumbi").
 *
 * Sintoma real (incidente 03-04/08/2026): a instância diz `open` e até
 * RECEBE mensagens, mas todo envio falha com "Connection Closed" — e os
 * remédios via API da Evolution (restart/logout) falham com o MESMO
 * erro. O único conserto é reiniciar o projeto Docker no VPS, coisa que
 * o CRM não tem como fazer sozinho. Então o trabalho aqui é detectar
 * rápido e AVISAR os admins com a instrução certa, em vez de deixar o
 * time descobrir na frente do cliente.
 *
 * Funcionamento: todo envio via evolution-api.ts reporta sucesso ou
 * falha aqui (gancho no evolutionFetch). N falhas "Connection Closed"
 * dentro da janela disparam UMA vez (cooldown) por instância:
 *   1. whatsapp_config.status = 'disconnected' (a tela de Settings
 *      passa a mostrar a verdade);
 *   2. notificação system_alert para owner/admins da conta com o
 *      passo a passo do restart no hPanel.
 * Um envio bem-sucedido zera o contador (e restaura o status).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const FAILURE_THRESHOLD = 3
const FAILURE_WINDOW_MS = 10 * 60_000
const ALERT_COOLDOWN_MS = 30 * 60_000

interface FailureTrack {
  count: number
  firstAt: number
  lastAlertAt: number
  /** true entre o alerta e o próximo envio OK — evita restaurar status à toa. */
  alerted: boolean
}

const tracks = new Map<string, FailureTrack>()

let _admin: SupabaseClient | null = null
function admin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  if (!_admin) _admin = createClient(url, key)
  return _admin
}

/**
 * Reporta o resultado de um envio da Evolution. Chamado pelo gancho em
 * evolution-api.ts — fire-and-forget, nunca lança.
 */
export function reportEvolutionSendOutcome(
  instanceName: string,
  ok: boolean,
  errorMessage?: string,
): void {
  try {
    if (!instanceName) return
    const now = Date.now()

    if (ok) {
      const track = tracks.get(instanceName)
      if (track?.alerted) {
        // Voltou a enviar (alguém reiniciou o container) — status volta
        // a 'connected' sem esperar o próximo connection.update.
        void restoreInstanceStatus(instanceName)
      }
      tracks.delete(instanceName)
      return
    }

    if (!/connection closed/i.test(errorMessage ?? '')) return

    let track = tracks.get(instanceName)
    if (!track || now - track.firstAt > FAILURE_WINDOW_MS) {
      track = { count: 0, firstAt: now, lastAlertAt: track?.lastAlertAt ?? 0, alerted: track?.alerted ?? false }
    }
    track.count += 1
    tracks.set(instanceName, track)

    if (
      track.count >= FAILURE_THRESHOLD &&
      now - track.lastAlertAt > ALERT_COOLDOWN_MS
    ) {
      track.lastAlertAt = now
      track.alerted = true
      void alertStuckInstance(instanceName, track.count)
    }
  } catch (err) {
    console.error('[connection-health] report failed:', err)
  }
}

async function restoreInstanceStatus(instanceName: string): Promise<void> {
  const db = admin()
  if (!db) return
  await db
    .from('whatsapp_config')
    .update({ status: 'connected' })
    .eq('evolution_instance_name', instanceName)
    .eq('status', 'disconnected')
}

async function alertStuckInstance(
  instanceName: string,
  failureCount: number,
): Promise<void> {
  try {
    const db = admin()
    if (!db) return

    const { data: config } = await db
      .from('whatsapp_config')
      .select('id, account_id, display_name, phone_number')
      .eq('evolution_instance_name', instanceName)
      .maybeSingle()
    if (!config) return

    await db
      .from('whatsapp_config')
      .update({ status: 'disconnected' })
      .eq('id', config.id)

    // Owner + admins da conta recebem o alerta no sino.
    const { data: recipients } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', config.account_id)
      .in('role', ['owner', 'admin'])

    const label =
      (config.display_name as string | null) ||
      (config.phone_number as string | null) ||
      instanceName

    const rows = (recipients ?? []).map((r: { user_id: string }) => ({
      account_id: config.account_id,
      user_id: r.user_id,
      type: 'system_alert',
      title: '⚠️ Conexão do WhatsApp travou',
      body:
        `O número "${label}" parou de enviar mensagens (${failureCount} falhas "Connection Closed" seguidas), ` +
        'mesmo aparecendo como conectado. Para resolver: painel da Hostinger → VPS → ' +
        'Gerenciador Docker → projeto evolution-api → Reiniciar. ' +
        'Recebimentos podem continuar chegando; os ENVIOS é que estão travados.',
    }))
    if (rows.length > 0) {
      await db.from('notifications').insert(rows)
    }

    console.error(
      `[connection-health] instância ${instanceName} travada (${failureCount} Connection Closed) — admins notificados`,
    )
  } catch (err) {
    console.error('[connection-health] alert failed:', err)
  }
}
