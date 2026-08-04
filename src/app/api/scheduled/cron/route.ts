/**
 * Backstop externo da fila de mensagens agendadas — mesmo padrão de
 * /api/broadcasts/cron: o caminho normal é o setInterval do
 * instrumentation.ts; esta rota cobre deploys serverless ou um curl
 * manual. Header `x-cron-secret` conferido contra AUTOMATION_CRON_SECRET.
 */

import { NextResponse } from 'next/server'
import { drainScheduledMessages } from '@/lib/whatsapp/scheduled-queue'

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

  const result = await drainScheduledMessages()
  return NextResponse.json(result)
}
