/**
 * Backstop externo do Radar de Leads (FASE 6, §10.5) — mesmo padrão dos
 * demais crons: o caminho normal é o relógio do instrumentation.ts;
 * esta rota cobre deploy serverless ou um disparo manual (útil para
 * testar sem esperar o tick).
 */

import { NextResponse } from 'next/server'
import { runRadarScan } from '@/lib/insights/analyzer'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: Request) {
  const expected =
    process.env.RADAR_CRON_SECRET || process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'Cron secret not configured' }, { status: 500 })
  }
  if ((request.headers.get('x-cron-secret') ?? '') !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const result = await runRadarScan()
  return NextResponse.json(result)
}
