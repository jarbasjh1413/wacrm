import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { syncDealFromRadar, parseRadarStage, parseValorEstimado } from './deal-sync'

// Aqui a IA mexe no board de vendas de verdade. O que mais dói para quem
// usa é o card voltar sozinho depois de a pessoa ter arrastado — então é
// isso que estes testes vigiam.

const STAGES = [
  { id: 's0', pipeline_id: 'p1', position: 0, radar_stage: 'novo' },
  { id: 's1', pipeline_id: 'p1', position: 1, radar_stage: 'qualificado' },
  { id: 's2', pipeline_id: 'p1', position: 2, radar_stage: 'negociando' },
  { id: 's3', pipeline_id: 'p1', position: 3, radar_stage: null }, // estágio do dono
  { id: 's4', pipeline_id: 'p1', position: 4, radar_stage: 'reservado' },
  { id: 's5', pipeline_id: 'p1', position: 5, radar_stage: 'ganho' },
  { id: 's6', pipeline_id: 'p1', position: 6, radar_stage: 'perdido' },
]

type ExistingDeal = Record<string, unknown> | null

/** Supabase de mentira: guarda o que foi inserido/atualizado. */
function makeDb(existing: ExistingDeal) {
  const calls: { inserted: Record<string, unknown> | null; updated: Record<string, unknown> | null } =
    { inserted: null, updated: null }

  function from(table: string) {
    const q: Record<string, unknown> = { table, op: 'select' }
    const chain = () => builder
    const builder = {
      select: chain,
      eq: chain,
      neq: chain,
      order: chain,
      limit: chain,
      insert(payload: Record<string, unknown>) {
        q.op = 'insert'
        calls.inserted = payload
        return builder
      },
      update(payload: Record<string, unknown>) {
        q.op = 'update'
        calls.updated = payload
        return builder
      },
      async maybeSingle() {
        return { data: single(), error: null }
      },
      async single() {
        return { data: single(), error: null }
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve({ data: list(), error: null }).then(resolve, reject)
      },
    }

    function single() {
      if (q.op === 'insert') return { id: 'deal-novo' }
      if (table === 'pipelines') return { id: 'p1' }
      if (table === 'deals') return existing
      return null
    }
    function list() {
      if (table === 'pipeline_stages') return STAGES
      if (table === 'profiles') return [{ user_id: 'u1', account_role: 'owner' }]
      return []
    }
    return builder
  }

  return { db: { from } as unknown as SupabaseClient, calls }
}

const BASE = {
  accountId: 'acc',
  contactId: 'contato',
  conversationId: 'conversa',
  contactName: 'Maria',
  interesse: 'notebook i5',
  valorEstimado: 3500,
  estagio: 'negociando' as const,
  temperatura: 'quente',
  intencao: 'compra',
}

describe('syncDealFromRadar — quando abrir um negócio', () => {
  it('abre o card com o valor que a IA leu na conversa', async () => {
    const { db, calls } = makeDb(null)
    const id = await syncDealFromRadar(db, BASE)
    expect(id).toBe('deal-novo')
    expect(calls.inserted?.value).toBe(3500)
    expect(calls.inserted?.stage_id).toBe('s2')
    expect(calls.inserted?.created_by_radar).toBe(true)
    expect(calls.inserted?.status).toBe('open')
    expect(calls.inserted?.title).toBe('Maria — notebook i5')
  })

  it('não abre card para quem procurou assistência', async () => {
    const { db, calls } = makeDb(null)
    const id = await syncDealFromRadar(db, { ...BASE, intencao: 'assistencia' })
    expect(id).toBeNull()
    expect(calls.inserted).toBeNull()
  })

  it('não abre card para compra sem nenhum sinal concreto', async () => {
    const { db, calls } = makeDb(null)
    const id = await syncDealFromRadar(db, {
      ...BASE,
      valorEstimado: null,
      estagio: null,
      temperatura: 'frio',
    })
    expect(id).toBeNull()
    expect(calls.inserted).toBeNull()
  })
})

describe('syncDealFromRadar — soberania de quem usa', () => {
  it('não mexe no valor que alguém digitou à mão', async () => {
    const { db, calls } = makeDb({
      id: 'd1',
      status: 'open',
      value: 2000,
      stage_id: 's2',
      value_locked_at: '2026-08-08T10:00:00Z',
      stage_locked_at: null,
    })
    await syncDealFromRadar(db, BASE)
    expect(calls.updated).toBeNull()
  })

  it('não move o card que alguém arrastou no board', async () => {
    const { db, calls } = makeDb({
      id: 'd1',
      status: 'open',
      value: 3500,
      stage_id: 's0',
      value_locked_at: null,
      stage_locked_at: '2026-08-08T10:00:00Z',
    })
    await syncDealFromRadar(db, BASE)
    expect(calls.updated).toBeNull()
  })

  it('atualiza só o valor quando o estágio está travado', async () => {
    const { db, calls } = makeDb({
      id: 'd1',
      status: 'open',
      value: 1000,
      stage_id: 's0',
      value_locked_at: null,
      stage_locked_at: '2026-08-08T10:00:00Z',
    })
    await syncDealFromRadar(db, BASE)
    expect(calls.updated).toEqual({ value: 3500 })
  })
})

describe('syncDealFromRadar — nunca anda para trás', () => {
  it('não volta o card de "reservado" para "negociando"', async () => {
    const { db, calls } = makeDb({
      id: 'd1',
      status: 'open',
      value: 3500,
      stage_id: 's4',
      value_locked_at: null,
      stage_locked_at: null,
    })
    await syncDealFromRadar(db, BASE)
    expect(calls.updated).toBeNull()
  })

  it('não puxa de volta card que está num estágio do dono (sem mapeamento)', async () => {
    const { db, calls } = makeDb({
      id: 'd1',
      status: 'open',
      value: 3500,
      stage_id: 's3', // posição 3, à frente do alvo 'negociando' (posição 2)
      value_locked_at: null,
      stage_locked_at: null,
    })
    await syncDealFromRadar(db, BASE)
    expect(calls.updated).toBeNull()
  })

  it('empurra adiante quando a conversa avançou', async () => {
    const { db, calls } = makeDb({
      id: 'd1',
      status: 'open',
      value: 3500,
      stage_id: 's1',
      value_locked_at: null,
      stage_locked_at: null,
    })
    await syncDealFromRadar(db, { ...BASE, estagio: 'reservado' })
    expect(calls.updated).toEqual({ stage_id: 's4' })
  })

  it('perdido pode vir de qualquer lugar do funil', async () => {
    const { db, calls } = makeDb({
      id: 'd1',
      status: 'open',
      value: 3500,
      stage_id: 's4',
      value_locked_at: null,
      stage_locked_at: null,
    })
    await syncDealFromRadar(db, { ...BASE, estagio: 'perdido' })
    expect(calls.updated).toEqual({ stage_id: 's6', status: 'lost' })
  })
})

describe('normalizadores', () => {
  it('aceita só o vocabulário canônico', () => {
    expect(parseRadarStage('NEGOCIANDO')).toBe('negociando')
    expect(parseRadarStage('quase fechando')).toBeNull()
    expect(parseRadarStage(null)).toBeNull()
  })

  it('lê dinheiro escrito de várias formas', () => {
    expect(parseValorEstimado(3500)).toBe(3500)
    expect(parseValorEstimado('R$ 3500')).toBe(3500)
    expect(parseValorEstimado('abc')).toBeNull()
  })
})
