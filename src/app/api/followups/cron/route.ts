/**
 * Backstop externo do agente de follow-up (FASE 5, §10) — mesmo padrão
 * dos crons de broadcasts/agendadas: o caminho normal é o relógio do
 * instrumentation.ts; esta rota cobre deploys serverless ou um disparo
 * manual. Aceita FOLLOWUP_CRON_SECRET ou AUTOMATION_CRON_SECRET no
 * header `x-cron-secret`. Força a varredura (ignora a janela de
 * horário — quem chama o backstop sabe o que está fazendo).
 */

import { NextResponse } from 'next/server'
import { runFollowupScan } from '@/lib/followups/engine'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: Request) {
  const expected =
    process.env.FOLLOWUP_CRON_SECRET || process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'Cron secret not configured' }, { status: 500 })
  }
  if ((request.headers.get('x-cron-secret') ?? '') !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const result = await runFollowupScan()
  return NextResponse.json(result)
}
