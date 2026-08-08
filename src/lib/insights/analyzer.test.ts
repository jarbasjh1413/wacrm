import { describe, expect, it } from 'vitest'
import { parseRadarAnalysis, normalizeMomentos } from './analyzer'

// A saída do Radar vira ação real (tag, escalada, follow-up agendado),
// então o parser precisa ser paranoico: o que a IA devolve é texto.
const NOW = new Date('2026-08-05T12:00:00Z')

describe('parseRadarAnalysis', () => {
  it('lê a análise completa', () => {
    const result = parseRadarAnalysis(
      JSON.stringify({
        temperatura: 'quente',
        interesse: 'notebook gamer até R$ 3.500',
        resumo: 'Cliente pediu opções e vai decidir no dia 20.',
        momentos_novos: [
          { tipo: 'promessa_data', texto: 'disse que compra dia 20' },
          { tipo: 'orcamento', texto: 'pode pagar R$ 300 por mês' },
        ],
        proximo_contato: {
          quando: '2026-08-20T13:00:00Z',
          motivo: 'cliente disse que compra no dia 20',
        },
        escalar_humano: false,
        escalar_motivo: null,
      }),
      NOW,
    )
    expect(result?.temperatura).toBe('quente')
    expect(result?.interesse).toBe('notebook gamer até R$ 3.500')
    expect(result?.momentos_novos).toHaveLength(2)
    expect(result?.momentos_novos[0].tipo).toBe('promessa_data')
    expect(result?.proximo_contato?.quando).toBe('2026-08-20T13:00:00.000Z')
    expect(result?.escalar_humano).toBe(false)
  })

  it('aceita JSON embrulhado em cerca de markdown', () => {
    const result = parseRadarAnalysis(
      '```json\n{"temperatura":"morno","momentos_novos":[]}\n```',
      NOW,
    )
    expect(result?.temperatura).toBe('morno')
  })

  it('descarta promessa no passado (cobraria na mesma hora)', () => {
    const result = parseRadarAnalysis(
      JSON.stringify({
        temperatura: 'morno',
        proximo_contato: { quando: '2026-07-01T10:00:00Z', motivo: 'ontem' },
        momentos_novos: [],
      }),
      NOW,
    )
    expect(result?.proximo_contato).toBeNull()
  })

  it('descarta promessa com data ilegível', () => {
    const result = parseRadarAnalysis(
      JSON.stringify({
        temperatura: 'frio',
        proximo_contato: { quando: 'semana que vem', motivo: 'x' },
        momentos_novos: [],
      }),
      NOW,
    )
    expect(result?.proximo_contato).toBeNull()
  })

  it('cai para indefinido quando a temperatura vem fora do vocabulário', () => {
    const result = parseRadarAnalysis(
      JSON.stringify({ temperatura: 'fervendo', momentos_novos: [] }),
      NOW,
    )
    expect(result?.temperatura).toBe('indefinido')
  })

  it('normaliza tipo de momento desconhecido e ignora texto vazio', () => {
    const result = parseRadarAnalysis(
      JSON.stringify({
        temperatura: 'morno',
        momentos_novos: [
          { tipo: 'inventado', texto: 'quer entrega rápida' },
          { tipo: 'objecao', texto: '   ' },
        ],
      }),
      NOW,
    )
    expect(result?.momentos_novos).toHaveLength(1)
    expect(result?.momentos_novos[0].tipo).toBe('interesse')
  })

  it('trata a string "null" como ausência de valor', () => {
    const result = parseRadarAnalysis(
      JSON.stringify({
        temperatura: 'frio',
        interesse: 'null',
        resumo: '',
        momentos_novos: [],
      }),
      NOW,
    )
    expect(result?.interesse).toBeNull()
    expect(result?.resumo).toBeNull()
  })

  it('devolve null quando não há JSON algum', () => {
    expect(parseRadarAnalysis('desculpe, não consegui analisar', NOW)).toBeNull()
    expect(parseRadarAnalysis('{quebrado', NOW)).toBeNull()
  })

  it('lê a intenção do atendimento', () => {
    const result = parseRadarAnalysis(
      JSON.stringify({
        temperatura: 'quente',
        intencao: 'assistencia',
        momentos_novos: [],
      }),
      NOW,
    )
    expect(result?.intencao).toBe('assistencia')
  })

  it('cai para indefinido quando a intenção vem fora do vocabulário', () => {
    const result = parseRadarAnalysis(
      JSON.stringify({ temperatura: 'frio', intencao: 'reclamacao', momentos_novos: [] }),
      NOW,
    )
    expect(result?.intencao).toBe('indefinido')
  })

  it('só escala com o booleano verdadeiro (não com "true" texto)', () => {
    const strict = parseRadarAnalysis(
      JSON.stringify({ temperatura: 'quente', escalar_humano: 'true', momentos_novos: [] }),
      NOW,
    )
    expect(strict?.escalar_humano).toBe(false)
  })
})

describe('normalizeMomentos', () => {
  it('preserva momentos válidos do banco', () => {
    const momentos = normalizeMomentos([
      { em: '2026-08-01T10:00:00Z', tipo: 'objecao', texto: 'achou caro' },
    ])
    expect(momentos).toHaveLength(1)
    expect(momentos[0].tipo).toBe('objecao')
  })

  it('descarta lixo sem derrubar o resto', () => {
    const momentos = normalizeMomentos([
      null,
      'texto solto',
      { texto: '' },
      { tipo: 'pessoal', texto: 'é produtor musical' },
    ])
    expect(momentos).toHaveLength(1)
    expect(momentos[0].texto).toBe('é produtor musical')
  })

  it('devolve lista vazia para JSONB inesperado', () => {
    expect(normalizeMomentos(null)).toEqual([])
    expect(normalizeMomentos({ nao: 'e array' })).toEqual([])
  })
})
