/**
 * Backstop externo da fila de broadcasts. O caminho normal é o
 * setInterval do instrumentation.ts (processo do Next, dev e VPS);
 * esta rota existe para um cron externo (ou um curl manual) drenar a
 * fila caso o processo esteja há muito tempo sem tick — mesmo padrão
 * de /api/automations/cron: header `x-cron-secret` conferido contra
 * AUTOMATION_CRON_SECRET.
 */

import { NextResponse } from 'next/server'
import { drainBroadcastQueue } from '@/lib/whatsapp/broadcast-queue'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'Cron secret not configured' }, { status: 500 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  if (supplied !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await drainBroadcastQueue()
  return NextResponse.json(result)
}
