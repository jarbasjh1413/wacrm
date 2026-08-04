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
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (globalThis.__broadcastQueueTimer) return

  const { drainBroadcastQueue } = await import('@/lib/whatsapp/broadcast-queue')

  globalThis.__broadcastQueueTimer = setInterval(() => {
    drainBroadcastQueue().catch((err) => {
      console.error('[broadcast-queue] drain tick failed:', err)
    })
  }, DRAIN_INTERVAL_MS)

  console.log('[broadcast-queue] fila de broadcasts ativa (tick a cada 15s)')
}
