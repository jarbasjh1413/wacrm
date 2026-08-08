import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { aplicaOsNoFunilDeServico } from './deal-bridge'

// A ponte é o momento em que a OS assume o card. Errar aqui tira o card da
// fila de cobrança na hora errada — e falha em silêncio, sem erro nenhum.

const SERVICO = 'p-servico'

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
      if (table === 'pipeline_stages') {
        return filtros.radar_stage === 'ganho' ? { id: 'v4' } : null
      }
      return null
    }
    function list() {
      if (table === 'pipelines') {
        return opts.semFunil ? [] : [{ id: SERVICO }]
      }
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

  it('máquina na bancada move o card, marca ganho e TRANCA', async () => {
    const { db, calls } = makeDb({ ...CARD })
    await aplicaOsNoFunilDeServico(db, { ...ENTRADA, status: 'Em serviço' })
    expect(calls.updated).toMatchObject({
      stage_id: 'v4',
      status: 'won',
      os_status: 'na_bancada',
    })
    expect(calls.updated?.stage_locked_at).toBeTruthy()
    expect(calls.updated?.value_locked_at).toBeTruthy()
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
