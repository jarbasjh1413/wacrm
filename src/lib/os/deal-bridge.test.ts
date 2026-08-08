import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { aplicaOsNoFunilDeServico } from './deal-bridge'

// A ponte é o momento em que a OS assume o card. Errar aqui tira o card da
// fila de cobrança na hora errada — e falha em silêncio, sem erro nenhum.

const SERVICO = 'p-servico'

// O funil de serviço depois da 054: as quatro últimas colunas são
// dirigidas pela OS, não pela IA.
const STAGES = [
  { id: 'v3', position: 3, os_situacao: 'aguardando_recebimento' },
  { id: 'v4', position: 4, os_situacao: 'na_bancada' },
  { id: 'v5', position: 5, os_situacao: 'aguardando_cliente' },
  { id: 'v6', position: 6, os_situacao: 'pronto' },
  { id: 'v7', position: 7, os_situacao: 'finalizada' },
  { id: 'v8', position: 8, os_situacao: null },
]

type Card = Record<string, unknown> | null

function makeDb(deal: Card, opts: { semFunil?: boolean } = {}) {
  const calls: { updated: Record<string, unknown> | null } = { updated: null }

  function from(table: string) {
    const filtros: Record<string, unknown> = {}
    let op = 'select'
    const chain = () => builder
    const builder = {
      select: chain,
      neq: chain,
      order: chain,
      limit: chain,
      in: chain,
      eq(col: string, val: unknown) {
        filtros[col] = val
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
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve({ data: list(), error: null }).then(
          resolve,
          reject,
        )
      },
    }
    function single() {
      if (op === 'update') return null
      if (table === 'deals') return deal
      return null
    }
    function list() {
      if (table === 'pipelines') {
        return opts.semFunil ? [] : [{ id: SERVICO }]
      }
      if (table === 'pipeline_stages') return STAGES
      return []
    }
    return builder
  }

  return { db: { from } as unknown as SupabaseClient, calls }
}

const CARD = {
  id: 'card-1',
  status: 'open',
  stage_id: 'v3', // "Vai trazer / vamos buscar"
  pipeline_id: SERVICO,
  os_id: null,
  os_status: null,
  stage_locked_at: null,
}

const ENTRADA = {
  accountId: 'acc',
  contactId: 'contato',
  osId: '7202',
  status: 'Aguardando retirada',
}

describe('aplicaOsNoFunilDeServico — a fronteira', () => {
  it('"Aguardando recebimento" NÃO move o card, só espelha a OS', async () => {
    // A OS já existe mas a máquina ainda está na casa do cliente: a
    // cobrança de "que dia você traz?" continua valendo.
    const { db, calls } = makeDb({ ...CARD })
    await aplicaOsNoFunilDeServico(db, {
      ...ENTRADA,
      status: 'Aguardando recebimento',
    })
    expect(calls.updated).toMatchObject({
      os_id: '7202',
      os_status: 'aguardando_recebimento',
    })
    expect(calls.updated).not.toHaveProperty('stage_id')
    expect(calls.updated).not.toHaveProperty('status')
  })

  it('máquina na bancada move o card para a coluna da OS', async () => {
    const { db, calls } = makeDb({ ...CARD })
    await aplicaOsNoFunilDeServico(db, { ...ENTRADA, status: 'Em serviço' })
    expect(calls.updated).toMatchObject({ stage_id: 'v4', os_status: 'na_bancada' })
    // Na bancada ainda não é ganho: o ganho do serviço é a entrega.
    expect(calls.updated).not.toHaveProperty('status')
  })

  it('o card SEGUE a OS coluna a coluna até a entrega', async () => {
    for (const [status, stage, situacao] of [
      ['Aguardando cliente', 'v5', 'aguardando_cliente'],
      ['Pronto para entrega', 'v6', 'pronto'],
      ['Aguardando retirada', 'v6', 'pronto'],
    ] as const) {
      const { db, calls } = makeDb({ ...CARD })
      await aplicaOsNoFunilDeServico(db, { ...ENTRADA, status })
      expect(calls.updated).toMatchObject({ stage_id: stage, os_status: situacao })
    }
  })

  it('"Finalizada" é o ganho do funil de serviço', async () => {
    const { db, calls } = makeDb({ ...CARD })
    await aplicaOsNoFunilDeServico(db, { ...ENTRADA, status: 'Finalizada' })
    expect(calls.updated).toMatchObject({ stage_id: 'v7', status: 'won' })
  })

  it('OS que volta de coluna NÃO puxa o card para trás', async () => {
    // Máquina voltou pra bancada depois de "pronta": quem volta card é gente.
    const { db, calls } = makeDb({ ...CARD, stage_id: 'v6' })
    await aplicaOsNoFunilDeServico(db, { ...ENTRADA, status: 'Em serviço' })
    expect(calls.updated).toMatchObject({ os_status: 'na_bancada' })
    expect(calls.updated).not.toHaveProperty('stage_id')
  })

  it('status desconhecido espelha mas não move', async () => {
    const { db, calls } = makeDb({ ...CARD })
    await aplicaOsNoFunilDeServico(db, {
      ...ENTRADA,
      status: 'Coluna Que Ele Criou Ontem',
    })
    expect(calls.updated).toMatchObject({ os_status: 'desconhecido' })
    expect(calls.updated).not.toHaveProperty('stage_id')
  })
})

describe('aplicaOsNoFunilDeServico — o que ela se recusa a fazer', () => {
  it('NUNCA cria card: máquina do balcão não vira lead', async () => {
    const { db, calls } = makeDb(null)
    await aplicaOsNoFunilDeServico(db, ENTRADA)
    expect(calls.updated).toBeNull()
  })

  it('sem funil de serviço na conta, não faz nada', async () => {
    const { db, calls } = makeDb({ ...CARD }, { semFunil: true })
    await aplicaOsNoFunilDeServico(db, ENTRADA)
    expect(calls.updated).toBeNull()
  })

  it('respeita o card que alguém arrastou à mão: só espelha', async () => {
    const { db, calls } = makeDb({
      ...CARD,
      stage_locked_at: '2026-08-08T10:00:00Z',
    })
    await aplicaOsNoFunilDeServico(db, ENTRADA)
    expect(calls.updated).toMatchObject({ os_status: 'pronto' })
    expect(calls.updated).not.toHaveProperty('stage_id')
  })

  it('reenviar o mesmo status é no-op (os_events não tem UNIQUE)', async () => {
    const { db, calls } = makeDb({
      ...CARD,
      os_id: '7202',
      os_status: 'pronto',
    })
    await aplicaOsNoFunilDeServico(db, ENTRADA)
    expect(calls.updated).toBeNull()
  })
})
