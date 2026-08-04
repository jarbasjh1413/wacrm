import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIMITS,
  isWithinSendWindow,
  jitterDelayMs,
  localParts,
  nextWindowStart,
  renderBroadcastMessage,
} from './broadcast-pacing'

// América/Sao_Paulo é UTC-3 (sem horário de verão desde 2019), então
// 12:00Z = 09:00 local. Datas fixas para o teste ser determinístico.
const TZ = DEFAULT_LIMITS.timezone

// Segunda-feira 20/07/2026.
const monday9amLocal = new Date('2026-07-20T12:00:00Z')
const monday8amLocal = new Date('2026-07-20T11:59:00Z')
const monday6pmLocal = new Date('2026-07-20T21:00:00Z')
// Domingo 19/07/2026, 10:00 local.
const sunday10amLocal = new Date('2026-07-19T13:00:00Z')

describe('localParts', () => {
  it('converts UTC instants to local hour + weekday', () => {
    expect(localParts(monday9amLocal, TZ)).toEqual({ hour: 9, dow: 1 })
    expect(localParts(sunday10amLocal, TZ)).toEqual({ hour: 10, dow: 0 })
  })
})

describe('isWithinSendWindow', () => {
  it('accepts business hours on allowed days', () => {
    expect(isWithinSendWindow(monday9amLocal, DEFAULT_LIMITS)).toBe(true)
  })

  it('rejects before the window opens and after it closes', () => {
    expect(isWithinSendWindow(monday8amLocal, DEFAULT_LIMITS)).toBe(false)
    // 18:00 local — janela é [9, 18), então 18h já está fora.
    expect(isWithinSendWindow(monday6pmLocal, DEFAULT_LIMITS)).toBe(false)
  })

  it('rejects disallowed days (domingo, por padrão)', () => {
    expect(isWithinSendWindow(sunday10amLocal, DEFAULT_LIMITS)).toBe(false)
  })
})

describe('nextWindowStart', () => {
  it('returns a moment inside the window, after now', () => {
    const next = nextWindowStart(monday6pmLocal, DEFAULT_LIMITS)
    expect(next.getTime()).toBeGreaterThan(monday6pmLocal.getTime())
    expect(isWithinSendWindow(next, DEFAULT_LIMITS)).toBe(true)
  })

  it('skips sunday entirely', () => {
    const next = nextWindowStart(sunday10amLocal, DEFAULT_LIMITS)
    expect(localParts(next, TZ).dow).toBe(1)
    expect(isWithinSendWindow(next, DEFAULT_LIMITS)).toBe(true)
  })

  it('never loops forever on an impossible config', () => {
    const impossible = { ...DEFAULT_LIMITS, send_days: [] as number[] }
    const next = nextWindowStart(monday9amLocal, impossible)
    expect(next.getTime()).toBeGreaterThan(monday9amLocal.getTime())
  })
})

describe('jitterDelayMs', () => {
  it('stays inside the configured range', () => {
    expect(jitterDelayMs(DEFAULT_LIMITS, () => 0)).toBe(30_000)
    expect(jitterDelayMs(DEFAULT_LIMITS, () => 1)).toBe(120_000)
    expect(jitterDelayMs(DEFAULT_LIMITS, () => 0.5)).toBe(75_000)
  })
})

describe('renderBroadcastMessage', () => {
  const contact = { name: 'Eduardo Maciel', phone: '+555182137329' }

  it('substitutes {{nome}}, {{primeiro_nome}} and {{telefone}}', () => {
    expect(
      renderBroadcastMessage(
        'Olá {{nome}}! Confirma o {{telefone}}? Abraço, {{primeiro_nome}}?',
        contact,
      ),
    ).toBe('Olá Eduardo Maciel! Confirma o +555182137329? Abraço, Eduardo?')
  })

  it('is case-insensitive and tolerates spaces inside the braces', () => {
    expect(renderBroadcastMessage('Oi {{ Nome }}!', contact)).toBe(
      'Oi Eduardo Maciel!',
    )
  })

  it('drops the variable cleanly when the contact has no name', () => {
    expect(
      renderBroadcastMessage('Olá {{nome}}! Tudo bem?', { name: null, phone: 'x' }),
    ).toBe('Olá! Tudo bem?')
  })

  it('leaves unknown variables intact so the author can spot them', () => {
    expect(renderBroadcastMessage('Oi {{apelido}}', contact)).toBe(
      'Oi {{apelido}}',
    )
  })

  it('preserves line breaks', () => {
    expect(
      renderBroadcastMessage('Olá {{nome}}!\n\nPromoção da semana.', contact),
    ).toBe('Olá Eduardo Maciel!\n\nPromoção da semana.')
  })
})
