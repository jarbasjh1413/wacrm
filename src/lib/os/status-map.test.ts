import { describe, expect, it } from 'vitest'
import { mapOsSituacao, maquinaChegou, normalizeOsStatus } from './status-map'

// As 11 colunas REAIS do kanban do sistema de OS do Jarbas, copiadas do
// prisma/seed.ts dele (Projetos/oficina-info-sistema, 08/08/2026). Se
// alguma parar de casar, a cobrança correspondente morre em silêncio —
// por isso cada uma tem teste próprio.
const COLUNAS_REAIS: Array<[string, string]> = [
  ['Aguardando recebimento', 'aguardando_recebimento'],
  ['Orçamento a fazer', 'na_bancada'],
  ['Revisões', 'na_bancada'],
  ['Em levantamento', 'na_bancada'],
  ['Enviar orçamento', 'na_bancada'],
  ['Aguardando cliente', 'aguardando_cliente'],
  ['Autorizado', 'na_bancada'],
  ['Em serviço', 'na_bancada'],
  ['Aguardando peça', 'na_bancada'],
  ['Pronto para entrega', 'pronto'],
  ['Aguardando retirada', 'pronto'],
  ['Finalizada', 'finalizada'],
]

describe('o vocabulário real do sistema de OS', () => {
  for (const [coluna, esperado] of COLUNAS_REAIS) {
    it(`"${coluna}" → ${esperado}`, () => {
      expect(mapOsSituacao(coluna)).toBe(esperado)
    })
  }
})

describe('normalizeOsStatus', () => {
  it('ignora acento, caixa e separador', () => {
    expect(normalizeOsStatus('Aguardando Retirada')).toBe('aguardando_retirada')
    expect(normalizeOsStatus('  AGUARDANDO  RETIRADA ')).toBe(
      'aguardando_retirada',
    )
    expect(normalizeOsStatus('aguardando-retirada')).toBe('aguardando_retirada')
    expect(normalizeOsStatus('Em serviço')).toBe('em_servico')
  })

  it('devolve null para vazio', () => {
    expect(normalizeOsStatus(null)).toBeNull()
    expect(normalizeOsStatus('   ')).toBeNull()
  })
})

describe('as três cobranças que valem dinheiro', () => {
  it('máquina pronta na prateleira dispara pelos dois nomes', () => {
    expect(mapOsSituacao('Pronto para entrega')).toBe('pronto')
    expect(mapOsSituacao('Aguardando retirada')).toBe('pronto')
  })

  it('orçamento esperando resposta é "Aguardando cliente"', () => {
    expect(mapOsSituacao('Aguardando cliente')).toBe('aguardando_cliente')
  })

  it('ainda aceita os slugs do contrato original', () => {
    expect(mapOsSituacao('orcamento_enviado')).toBe('aguardando_cliente')
    expect(mapOsSituacao('entregue')).toBe('finalizada')
    expect(mapOsSituacao('pronto')).toBe('pronto')
  })
})

describe('maquinaChegou — a fronteira entre o CRM e a OS', () => {
  it('OS aberta com a máquina ainda na casa do cliente NÃO conta como chegada', () => {
    expect(maquinaChegou('Aguardando recebimento')).toBe(false)
  })

  it('qualquer coluna da bancada em diante conta como chegada', () => {
    expect(maquinaChegou('Orçamento a fazer')).toBe(true)
    expect(maquinaChegou('Em serviço')).toBe(true)
    expect(maquinaChegou('Aguardando retirada')).toBe(true)
  })

  it('status desconhecido ou vazio NÃO move o card', () => {
    // Marcar "chegou" cedo demais tira o card da fila de cobrança
    // exatamente quando ele ainda precisa ser cobrado.
    expect(maquinaChegou('Coluna Nova Que Ele Criou')).toBe(false)
    expect(maquinaChegou(null)).toBe(false)
    expect(maquinaChegou('')).toBe(false)
  })
})
