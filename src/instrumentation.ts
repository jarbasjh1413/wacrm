/**
 * Hook de inicialização do Next (roda uma vez quando o servidor sobe).
 *
 * Liga o relógio da fila de broadcasts: a cada 15s o processo drena a
 * fila (broadcast-queue.ts decide quem está devido — o jitter de
 * 30–120s vive em broadcasts.next_send_at, não aqui). Funciona em dev
 * (`npm run dev`) e em produção num servidor Node de vida longa (VPS).
 * Se um dia o app for para serverless (Vercel), este intervalo não
 * sobrevive entre invocações — usar o backstop /api/broadcasts/cron
 * com um cron externo.
 *
 * O guard global evita intervalos duplicados quando o dev server
 * recompila (HMR re-executa módulos, mas o globalThis persiste).
 */

const DRAIN_INTERVAL_MS = 15_000

declare global {
  // eslint-disable-next-line no-var
  var __broadcastQueueTimer: ReturnType<typeof setInterval> | undefined
  // eslint-disable-next-line no-var
  var __followupTimer: ReturnType<typeof setInterval> | undefined
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (globalThis.__broadcastQueueTimer) return

  const { drainBroadcastQueue } = await import('@/lib/whatsapp/broadcast-queue')
  const { drainScheduledMessages } = await import(
    '@/lib/whatsapp/scheduled-queue'
  )
  const { maybeRunFollowupScan } = await import('@/lib/followups/engine')

  globalThis.__broadcastQueueTimer = setInterval(() => {
    drainBroadcastQueue().catch((err) => {
      console.error('[broadcast-queue] drain tick failed:', err)
    })
    drainScheduledMessages().catch((err) => {
      console.error('[scheduled-queue] drain tick failed:', err)
    })
  }, DRAIN_INTERVAL_MS)

  // Agente de follow-up: checagem a cada 30 min; o próprio engine se
  // limita a ~2 varreduras/dia por conta, em horário comercial (§10).
  globalThis.__followupTimer ??= setInterval(() => {
    maybeRunFollowupScan()
      .then((r) => {
        if (r && (r.autoSent || r.queued)) {
          console.log(
            `[followups] varredura: ${r.autoSent} auto, ${r.queued} na fila, ${r.skippedByAi} dispensados pela IA`,
          )
        }
      })
      .catch((err) => console.error('[followups] scan failed:', err))
  }, 30 * 60_000)

  console.log(
    '[broadcast-queue] filas de broadcasts + agendadas + agente de follow-up ativos',
  )
}
