import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  syncDealFromRadar,
  parseRadarStage,
  parseValorEstimado,
  parseFunil,
} from './deal-sync'

// Aqui a IA mexe no board de vendas e no de serviço. O que mais dói para
// quem usa é o card voltar sozinho depois de a pessoa ter arrastado, ou o
// lead cair no quadro errado — é isso que estes testes vigiam.

const VENDAS = 'p-vendas'
const SERVICO = 'p-servico'

const STAGES = [
  // Vendas
  { id: 's0', pipeline_id: VENDAS, position: 0, radar_stage: 'novo' },
  { id: 'sq', pipeline_id: VENDAS, position: 1, radar_stage: 'qualificando' },
  { id: 's1', pipeline_id: VENDAS, position: 2, radar_stage: 'qualificado' },
  { id: 's2', pipeline_id: VENDAS, position: 3, radar_stage: 'orcamento' },
  { id: 'sn', pipeline_id: VENDAS, position: 4, radar_stage: 'negociando' },
  { id: 's3', pipeline_id: VENDAS, position: 5, radar_stage: null }, // do dono
  { id: 's4', pipeline_id: VENDAS, position: 6, radar_stage: 'reservado' },
  { id: 's5', pipeline_id: VENDAS, position: 7, radar_stage: 'ganho' },
  { id: 's6', pipeline_id: VENDAS, position: 8, radar_stage: 'perdido' },
  // Serviço (053)
  { id: 'v0', pipeline_id: SERVICO, position: 0, radar_stage: 'novo' },
  { id: 'v1', pipeline_id: SERVICO, position: 1, radar_stage: 'qualificado' },
  { id: 'v2', pipeline_id: SERVICO, position: 2, radar_stage: 'orcamento' },
  { id: 'v3', pipeline_id: SERVICO, position: 3, radar_stage: 'reservado' },
  { id: 'v4', pipeline_id: SERVICO, position: 4, radar_stage: 'ganho' },
  { id: 'v5', pipeline_id: SERVICO, position: 5, radar_stage: 'perdido' },
]

type ExistingDeal = Record<string, unknown> | null

/** Supabase de mentira: guarda o que foi inserido/atualizado. */
function makeDb(existing: ExistingDeal, opts: { semServico?: boolean } = {}) {
  const calls: {
    inserted: Record<string, unknown> | null
    updated: Record<string, unknown> | null
  } = { inserted: null, updated: null }

  const pipelines = [
    { id: VENDAS, tipo: 'vendas' },
    ...(opts.semServico ? [] : [{ id: SERVICO, tipo: 'servico' }]),
  ]

  function from(table: string) {
    const filtros: Record<string, unknown> = {}
    let op = 'select'
    const chain = () => builder
    const builder = {
      select: chain,
      neq: chain,
      order: chain,
      limit: chain,
      eq(col: string, val: unknown) {
        filtros[col] = val
        return builder
      },
      in(col: string, vals: unknown[]) {
        filtros[col] = vals
        return builder
      },
      insert(payload: Record<string, unknown>) {
        op = 'insert'
        calls.inserted = payload
        return builder
      },
      update(payload: Record<string, unknown>) {
        op = 'update'
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
        return Promise.resolve({ data: list(), error: null }).then(
          resolve,
          reject,
        )
      },
    }

    function single() {
      if (op === 'insert') return { id: 'deal-novo' }
      if (table === 'deals') {
        if (!existing) return null
        // O simulador precisa respeitar os filtros, senão a busca "acha"
        // o card do outro quadro e o teste passa por acidente.
        const ids = filtros.pipeline_id
        if (Array.isArray(ids) && !ids.includes(existing.pipeline_id)) {
          return null
        }
        if (filtros.status && existing.status !== filtros.status) return null
        return existing
      }
      return null
    }
    function list() {
      if (table === 'pipelines') return pipelines
      if (table === 'pipeline_stages') {
        return STAGES.filter((s) => s.pipeline_id === filtros.pipeline_id)
      }
      if (table === 'profiles') {
        return [{ user_id: 'u1', account_role: 'owner' }]
      }
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
  estagio: 'orcamento' as const,
  temperatura: 'quente',
  intencao: 'compra',
}

const CONSERTO = {
  ...BASE,
  interesse: 'Dell Inspiron não liga',
  valorEstimado: null,
  temperatura: 'morno',
  intencao: 'assistencia',
  estagio: 'qualificado' as const,
}

describe('syncDealFromRadar — em qual quadro o cliente entra', () => {
  it('compra abre card no funil de vendas', async () => {
    const { db, calls } = makeDb(null)
    const r = await syncDealFromRadar(db, BASE)
    expect(r).toEqual({ dealId: 'deal-novo', funil: 'vendas' })
    expect(calls.inserted?.pipeline_id).toBe(VENDAS)
    expect(calls.inserted?.value).toBe(3500)
  })

  it('assistência abre card no funil de SERVIÇO, nunca no de vendas', async () => {
    const { db, calls } = makeDb(null)
    const r = await syncDealFromRadar(db, CONSERTO)
    expect(r?.funil).toBe('servico')
    expect(calls.inserted?.pipeline_id).toBe(SERVICO)
    expect(calls.inserted?.stage_id).toBe('v1')
  })

  it('pós-venda (garantia) também é serviço', async () => {
    const { db, calls } = makeDb(null)
    await syncDealFromRadar(db, { ...CONSERTO, intencao: 'pos_venda' })
    expect(calls.inserted?.pipeline_id).toBe(SERVICO)
  })

  it('a IA declarando o quadro ganha da intenção', async () => {
    // "quanto custa trocar a tela" — intenção orcamento, mas é conserto.
    const { db, calls } = makeDb(null)
    await syncDealFromRadar(db, {
      ...CONSERTO,
      intencao: 'orcamento',
      funil: 'servico',
    })
    expect(calls.inserted?.pipeline_id).toBe(SERVICO)
  })

  it('sem funil de serviço na conta, NÃO despeja o conserto em vendas', async () => {
    const { db, calls } = makeDb(null, { semServico: true })
    const r = await syncDealFromRadar(db, CONSERTO)
    expect(r).toBeNull()
    expect(calls.inserted).toBeNull()
  })

  it('quadro indefinido não abre card nenhum', async () => {
    const { db, calls } = makeDb(null)
    const r = await syncDealFromRadar(db, {
      ...BASE,
      intencao: 'informacao',
      funil: null,
    })
    expect(r).toBeNull()
    expect(calls.inserted).toBeNull()
  })

  it('quadro indefinido acerta o valor mas NÃO move de coluna', async () => {
    const { db, calls } = makeDb({
      id: 'd1',
      status: 'open',
      value: 1000,
      stage_id: 's1',
      pipeline_id: VENDAS,
      value_locked_at: null,
      stage_locked_at: null,
    })
    await syncDealFromRadar(db, { ...BASE, intencao: 'informacao', funil: null })
    expect(calls.updated).toEqual({ value: 3500 })
  })
})

describe('syncDealFromRadar — o teto da IA no serviço', () => {
  it('rebaixa "ganho" para "reservado": quem diz que a máquina chegou é a OS', async () => {
    const { db, calls } = makeDb(null)
    await syncDealFromRadar(db, { ...CONSERTO, estagio: 'ganho' })
    expect(calls.inserted?.stage_id).toBe('v3')
    expect(calls.inserted?.status).toBe('open')
  })

  it('conserto sem estágio entra como "novo" em vez de sumir', async () => {
    const { db, calls } = makeDb(null)
    await syncDealFromRadar(db, { ...CONSERTO, estagio: null })
    expect(calls.inserted?.stage_id).toBe('v0')
  })

  it('não abre card de conserto que já nasce morto', async () => {
    const { db, calls } = makeDb(null)
    const r = await syncDealFromRadar(db, { ...CONSERTO, estagio: 'perdido' })
    expect(r).toBeNull()
    expect(calls.inserted).toBeNull()
  })

  it('card de serviço nasce sem valor — orçamento de verdade é o da bancada', async () => {
    const { db, calls } = makeDb(null)
    await syncDealFromRadar(db, { ...CONSERTO, valorEstimado: 800 })
    expect(calls.inserted?.value).toBe(0)
  })
})

describe('syncDealFromRadar — máquina que já passou pela bancada', () => {
  // Com a ponte da OS marcando 'won', o card de serviço ganho é o estado
  // NORMAL. Se ele bloqueasse, o cliente nunca mais geraria um conserto.
  it('card de serviço ganho não impede um conserto novo', async () => {
    const { db, calls } = makeDb(null) // a busca filtra status='open'
    const r = await syncDealFromRadar(db, CONSERTO)
    expect(r?.funil).toBe('servico')
    expect(calls.inserted).not.toBeNull()
  })

  it('o mesmo contato pode ter card nos dois quadros ao mesmo tempo', async () => {
    // Já tem conserto aberto; agora ele quer comprar um notebook.
    const { db, calls } = makeDb({
      id: 'conserto-1',
      status: 'open',
      value: 0,
      stage_id: 'v1',
      pipeline_id: SERVICO,
      value_locked_at: null,
      stage_locked_at: null,
    })
    const r = await syncDealFromRadar(db, BASE)
    // A busca é filtrada por funil, então o card de conserto não é "adotado".
    expect(r?.funil).toBe('vendas')
    expect(calls.inserted?.pipeline_id).toBe(VENDAS)
  })
})

describe('syncDealFromRadar — soberania de quem usa', () => {
  it('não mexe no valor que alguém digitou à mão', async () => {
    const { db, calls } = makeDb({
      id: 'd1',
      status: 'open',
      value: 2000,
      stage_id: 's2',
      pipeline_id: VENDAS,
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
      pipeline_id: VENDAS,
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
      pipeline_id: VENDAS,
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
      pipeline_id: VENDAS,
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
      pipeline_id: VENDAS,
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
      pipeline_id: VENDAS,
      value_locked_at: null,
      stage_locked_at: null,
    })
    await syncDealFromRadar(db, { ...BASE, estagio: 'reservado' })
    expect(calls.updated).toEqual({ stage_id: 's4' })
  })

  it('no serviço, "vai trazer" também é avanço normal', async () => {
    const { db, calls } = makeDb({
      id: 'd1',
      status: 'open',
      value: 0,
      stage_id: 'v1',
      pipeline_id: SERVICO,
      value_locked_at: null,
      stage_locked_at: null,
    })
    await syncDealFromRadar(db, { ...CONSERTO, estagio: 'reservado' })
    expect(calls.updated).toEqual({ stage_id: 'v3' })
  })

  it('perdido pode vir de qualquer lugar do funil', async () => {
    const { db, calls } = makeDb({
      id: 'd1',
      status: 'open',
      value: 3500,
      stage_id: 's4',
      pipeline_id: VENDAS,
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

  it('lê o quadro e descarta lixo', () => {
    expect(parseFunil('servico')).toBe('servico')
    expect(parseFunil(' VENDAS ')).toBe('vendas')
    expect(parseFunil('conserto')).toBeNull()
    expect(parseFunil(undefined)).toBeNull()
  })
})
