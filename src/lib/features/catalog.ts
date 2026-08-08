/**
 * Central de Recursos (049) — o vocabulário e a regra de "está ligado?".
 *
 * Duas garantias que valem mais que o código:
 *   1. **Padrão LIGADO.** Recurso sem linha em `account_features`
 *      funciona. Assim nada quebra em conta existente e recurso novo
 *      não precisa de backfill.
 *   2. **Modo manual manda.** Ligado, ele derruba TODO automatismo de
 *      uma vez — o CRM vira "só um app onde eu respondo à mão", que é
 *      exatamente o pedido do Jarbas. Nenhum recurso individual escapa.
 */

export const FEATURES = [
  'radar',
  'followup',
  'auto_reply',
  'automations',
  'flows',
  'broadcasts',
  'scheduled',
  'transcription',
  'vision',
] as const

export type FeatureKey = (typeof FEATURES)[number]

/** Interruptor mestre. Fora de FEATURES porque não é um recurso — é o disjuntor. */
export const MANUAL_MODE = 'modo_manual'

/** Recursos que gastam a chave de IA da conta (mostrado na tela). */
export const AI_FEATURES: ReadonlySet<FeatureKey> = new Set([
  'radar',
  'followup',
  'auto_reply',
  'transcription',
  'vision',
])

export type FeatureState = Record<string, boolean>

/**
 * Interpreta as linhas de `account_features`. Recebe o que veio do
 * banco e responde a única pergunta que importa nos motores.
 */
export function isEnabled(state: FeatureState, feature: FeatureKey): boolean {
  if (state[MANUAL_MODE] === true) return false
  return state[feature] !== false
}

/** Modo manual está ligado? (para a UI destacar o estado global.) */
export function isManualMode(state: FeatureState): boolean {
  return state[MANUAL_MODE] === true
}

/** Converte as linhas do banco no mapa que `isEnabled` espera. */
export function toFeatureState(
  rows: { feature: string; enabled: boolean }[] | null | undefined,
): FeatureState {
  const state: FeatureState = {}
  for (const row of rows ?? []) state[row.feature] = row.enabled
  return state
}
