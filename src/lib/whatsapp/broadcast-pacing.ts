/**
 * Regras de ritmo anti-ban dos broadcasts (CLAUDE.md §11) — funções puras.
 *
 * O drenador da fila (broadcast-queue.ts) decide QUANDO enviar usando isto:
 *   - janela de horário comercial + dias permitidos, no fuso da conta;
 *   - jitter aleatório entre envios (30–120s por padrão);
 *   - substituição das variáveis {{nome}} / {{primeiro_nome}} / {{telefone}}.
 *
 * Tudo recebe `now`/`rand` por parâmetro para os testes serem determinísticos.
 */

export interface BroadcastLimits {
  daily_cap: number
  min_delay_seconds: number
  max_delay_seconds: number
  /** Hora local de início (inclusiva) e fim (exclusiva) da janela, 0–24. */
  send_window_start: number
  send_window_end: number
  /** Dias permitidos: 0 = domingo … 6 = sábado. */
  send_days: number[]
  /** Fuso IANA usado para "hora local" (ex.: America/Sao_Paulo). */
  timezone: string
}

/** Padrões da §11 — usados quando a conta não tem linha em broadcast_limits. */
export const DEFAULT_LIMITS: BroadcastLimits = {
  daily_cap: 50,
  min_delay_seconds: 30,
  max_delay_seconds: 120,
  send_window_start: 9,
  send_window_end: 18,
  send_days: [1, 2, 3, 4, 5, 6],
  timezone: 'America/Sao_Paulo',
}

const WEEKDAY_TO_DOW: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

/** Hora (0–23) e dia da semana (0–6) de `now` no fuso da conta. */
export function localParts(
  now: Date,
  timezone: string,
): { hour: number; dow: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(now)
  let hour = 0
  let dow = 0
  for (const p of parts) {
    if (p.type === 'hour') hour = Number(p.value)
    if (p.type === 'weekday') dow = WEEKDAY_TO_DOW[p.value] ?? 0
  }
  return { hour, dow }
}

/** `now` está dentro da janela de envio da conta? */
export function isWithinSendWindow(now: Date, limits: BroadcastLimits): boolean {
  const { hour, dow } = localParts(now, limits.timezone)
  if (!limits.send_days.includes(dow)) return false
  return hour >= limits.send_window_start && hour < limits.send_window_end
}

/**
 * Próximo instante dentro da janela de envio, a partir de `now`.
 * Avança em passos de 15 min até entrar na janela (limitado a 8 dias —
 * uma configuração sem dia permitido cai no fallback de +1 dia em vez
 * de laço infinito). Granularidade de 15 min é suficiente: o drenador
 * roda com frequência e só precisa de um "acorde por volta de".
 */
export function nextWindowStart(now: Date, limits: BroadcastLimits): Date {
  const STEP_MS = 15 * 60_000
  const LIMIT = (8 * 24 * 60) / 15 // 8 dias em passos de 15 min
  let candidate = new Date(Math.ceil(now.getTime() / STEP_MS) * STEP_MS)
  for (let i = 0; i < LIMIT; i++) {
    if (isWithinSendWindow(candidate, limits)) return candidate
    candidate = new Date(candidate.getTime() + STEP_MS)
  }
  return new Date(now.getTime() + 24 * 60 * 60_000)
}

/** Delay aleatório entre envios, em ms (§11.1: 30–120s por padrão). */
export function jitterDelayMs(
  limits: BroadcastLimits,
  rand: () => number = Math.random,
): number {
  const min = limits.min_delay_seconds * 1000
  const max = limits.max_delay_seconds * 1000
  return Math.round(min + rand() * (max - min))
}

/**
 * Substitui as variáveis do corpo do broadcast pelos dados do contato.
 * Variáveis desconhecidas ficam intactas (aparecem no preview, então o
 * autor percebe o erro antes de enviar). Nome vazio: a variável some e
 * espaços duplicados são normalizados ("Olá {{nome}}!" → "Olá !" → "Olá!").
 */
export function renderBroadcastMessage(
  text: string,
  contact: { name?: string | null; phone?: string | null },
): string {
  const name = (contact.name ?? '').trim()
  const firstName = name.split(/\s+/)[0] ?? ''
  const rendered = text
    .replace(/\{\{\s*nome\s*\}\}/gi, name)
    .replace(/\{\{\s*primeiro_nome\s*\}\}/gi, firstName)
    .replace(/\{\{\s*telefone\s*\}\}/gi, contact.phone ?? '')
  return rendered
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/[^\S\n]+([!?.,;:])/g, '$1')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
}
