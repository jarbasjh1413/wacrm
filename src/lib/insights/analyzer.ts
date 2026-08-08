/**
 * Radar de Leads — o analisador (FASE 6, CLAUDE.md §10.5).
 *
 * A IA lê as conversas e monta o dossiê de cada lead. Fluxo:
 *
 *   1. ELEGE conversas: têm mensagem nova desde a última análise E
 *      esfriaram (ninguém escreve há N minutos — analisar no meio de uma
 *      troca de mensagens queimaria tokens e leria contexto pela metade);
 *   2. LÊ o histórico + o dossiê anterior e pede à IA: temperatura
 *      (segundo os critérios que o dono ensinou EM PORTUGUÊS), interesse,
 *      resumo, momentos-chave NOVOS, data prometida pelo cliente e se é
 *      hora de chamar um humano;
 *   3. GRAVA o dossiê (momentos são append-only — a memória do lead) e
 *      DISPARA as ações: tag de temperatura no contato, escalada com
 *      notificação, e a promessa que vira follow-up agendado.
 *
 * Exemplo canônico (Jarbas): "vou comprar dia 20" → promessa gravada →
 * agente cobra no dia 20 → "só mês que vem" → reagenda, esfria →
 * "consegui um adiantamento" → QUENTE + humano avisado na hora.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from '@/lib/ai/config'
import { buildConversationContext } from '@/lib/ai/context'
import { generateReply } from '@/lib/ai/generate'
import { logAiUsage } from '@/lib/ai/usage'

export type Temperatura = 'quente' | 'morno' | 'frio' | 'indefinido'

export type MomentoTipo =
  | 'promessa_data'
  | 'objecao'
  | 'orcamento'
  | 'interesse'
  | 'pessoal'

export interface Momento {
  /** ISO — quando o momento foi capturado. */
  em: string
  tipo: MomentoTipo
  texto: string
}

/** O que a IA devolve por conversa analisada. */
export interface RadarAnalysis {
  temperatura: Temperatura
  interesse: string | null
  resumo: string | null
  momentos_novos: Momento[]
  proximo_contato: { quando: string; motivo: string } | null
  escalar_humano: boolean
  escalar_motivo: string | null
}

export interface RadarScanResult {
  analisadas: number
  escaladas: number
  promessas: number
  erros: number
}

const MAX_CONVERSATIONS_PER_TICK = 8
const MAX_MOMENTOS_STORED = 40
const MOMENTO_TIPOS: ReadonlySet<string> = new Set([
  'promessa_data',
  'objecao',
  'orcamento',
  'interesse',
  'pessoal',
])

const DEFAULT_CRITERIOS = {
  quente:
    'Perguntou preço, parcelamento ou formas de pagamento; falou em ir à loja; deu prazo curto para decidir; demonstrou urgência.',
  morno:
    'Demonstrou interesse real mas sem data definida; está comparando opções; pediu informações técnicas.',
  frio:
    'Só curiosidade, sumiu há vários dias, disse que vai deixar para depois ou que não tem interesse agora.',
}

let _admin: SupabaseClient | null = null
function admin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  if (!_admin) _admin = createClient(url, key)
  return _admin
}

// ---------------------------------------------------------------------------
// Varredura

/** Roda o Radar para todas as contas com ele ligado. Nunca lança. */
export async function runRadarScan(
  now: Date = new Date(),
): Promise<RadarScanResult> {
  const result: RadarScanResult = {
    analisadas: 0,
    escaladas: 0,
    promessas: 0,
    erros: 0,
  }
  const db = admin()
  if (!db) return result

  const { data: accounts } = await db.from('accounts').select('id')
  for (const account of accounts ?? []) {
    try {
      await scanAccount(db, account.id as string, now, result)
    } catch (err) {
      result.erros++
      console.error(`[radar] conta ${account.id} falhou:`, err)
    }
  }
  return result
}

interface RadarSettings {
  radar_enabled: boolean
  radar_debounce_minutos: number
  contexto_negocio: string | null
  criterios_quente: string | null
  criterios_morno: string | null
  criterios_frio: string | null
}

async function scanAccount(
  db: SupabaseClient,
  accountId: string,
  now: Date,
  result: RadarScanResult,
): Promise<void> {
  const { data: settingsRow } = await db
    .from('followup_settings')
    .select(
      'radar_enabled, radar_debounce_minutos, contexto_negocio, criterios_quente, criterios_morno, criterios_frio',
    )
    .eq('account_id', accountId)
    .maybeSingle()
  const settings: RadarSettings = {
    radar_enabled: settingsRow?.radar_enabled ?? true,
    radar_debounce_minutos: settingsRow?.radar_debounce_minutos ?? 10,
    contexto_negocio: settingsRow?.contexto_negocio ?? null,
    criterios_quente: settingsRow?.criterios_quente ?? null,
    criterios_morno: settingsRow?.criterios_morno ?? null,
    criterios_frio: settingsRow?.criterios_frio ?? null,
  }
  if (!settings.radar_enabled) return

  // requireActive: false — is_active governa o bot de auto-resposta do
  // inbox; o Radar tem o próprio interruptor.
  const aiConfig = await loadAiConfig(db, accountId, { requireActive: false })
  if (!aiConfig) return

  const cutoff = new Date(
    now.getTime() - settings.radar_debounce_minutos * 60_000,
  ).toISOString()

  // Conversas que esfriaram e têm mensagem nova desde a última análise.
  const { data: candidates } = await db
    .from('conversations')
    .select('id, contact_id, last_message_at, insight:conversation_insights(ultima_mensagem_analisada_em)')
    .eq('account_id', accountId)
    .not('last_message_at', 'is', null)
    .lt('last_message_at', cutoff)
    .order('last_message_at', { ascending: false })
    .limit(60)

  const pending = (candidates ?? []).filter((c) => {
    const insightRaw = (c as Record<string, unknown>).insight
    const insight = Array.isArray(insightRaw) ? insightRaw[0] : insightRaw
    const analisada = (insight as { ultima_mensagem_analisada_em?: string })
      ?.ultima_mensagem_analisada_em
    if (!analisada) return true
    return new Date(c.last_message_at as string) > new Date(analisada)
  })

  for (const conv of pending.slice(0, MAX_CONVERSATIONS_PER_TICK)) {
    try {
      await analyzeConversation(
        db,
        accountId,
        aiConfig,
        settings,
        {
          id: conv.id as string,
          contactId: (conv.contact_id as string | null) ?? null,
          lastMessageAt: conv.last_message_at as string,
        },
        now,
        result,
      )
    } catch (err) {
      result.erros++
      console.error(`[radar] conversa ${conv.id} falhou:`, err)
    }
  }
}

// ---------------------------------------------------------------------------
// Análise de uma conversa

async function analyzeConversation(
  db: SupabaseClient,
  accountId: string,
  aiConfig: NonNullable<Awaited<ReturnType<typeof loadAiConfig>>>,
  settings: RadarSettings,
  conv: { id: string; contactId: string | null; lastMessageAt: string },
  now: Date,
  result: RadarScanResult,
): Promise<void> {
  const history = await buildConversationContext(db, conv.id, 30)
  // Sem texto não há o que interpretar (conversa só de mídia, por ex.).
  if (history.length === 0) {
    await db.from('conversation_insights').upsert(
      {
        account_id: accountId,
        conversation_id: conv.id,
        contact_id: conv.contactId,
        ultima_analise_em: now.toISOString(),
        ultima_mensagem_analisada_em: conv.lastMessageAt,
      },
      { onConflict: 'conversation_id' },
    )
    return
  }

  const { data: previous } = await db
    .from('conversation_insights')
    .select('temperatura, interesse, resumo, momentos, proximo_contato_em')
    .eq('conversation_id', conv.id)
    .maybeSingle()

  const systemPrompt = buildRadarPrompt(settings, previous, now)

  const { text, usage } = await generateReply({
    config: aiConfig,
    systemPrompt,
    // A conversa quase sempre termina em turno nosso; fechar com um
    // turno de usuário evita que a API trate como prefill (o modelo
    // tentaria "continuar" a última frase e devolveria vazio).
    messages: [
      ...history,
      {
        role: 'user' as const,
        content:
          '[instrução do sistema — o cliente NÃO escreveu isto] Analise a conversa acima e responda AGORA apenas com o JSON pedido.',
      },
    ],
  })

  void logAiUsage(db, {
    accountId,
    conversationId: conv.id,
    mode: 'radar',
    provider: aiConfig.provider,
    model: aiConfig.model,
    usage,
  })

  const analysis = parseRadarAnalysis(text, now)
  if (!analysis) {
    result.erros++
    console.error(`[radar] resposta ilegível da IA na conversa ${conv.id}`)
    return
  }

  const momentosAnteriores = normalizeMomentos(previous?.momentos)
  const momentos = [...momentosAnteriores, ...analysis.momentos_novos].slice(
    -MAX_MOMENTOS_STORED,
  )

  const promessaNova =
    analysis.proximo_contato &&
    analysis.proximo_contato.quando !== previous?.proximo_contato_em

  const { error } = await db.from('conversation_insights').upsert(
    {
      account_id: accountId,
      conversation_id: conv.id,
      contact_id: conv.contactId,
      temperatura: analysis.temperatura,
      interesse: analysis.interesse,
      resumo: analysis.resumo,
      momentos,
      ...(analysis.proximo_contato
        ? {
            proximo_contato_em: analysis.proximo_contato.quando,
            proximo_contato_motivo: analysis.proximo_contato.motivo,
            // Promessa nova reabre a janela de cobrança.
            ...(promessaNova ? { promessa_atendida_em: null } : {}),
          }
        : {}),
      ...(analysis.escalar_humano
        ? {
            escalado_em: now.toISOString(),
            escalado_motivo: analysis.escalar_motivo,
          }
        : {}),
      ultima_analise_em: now.toISOString(),
      ultima_mensagem_analisada_em: conv.lastMessageAt,
    },
    { onConflict: 'conversation_id' },
  )
  if (error) throw new Error(error.message)

  result.analisadas++
  if (promessaNova) result.promessas++

  // Ações — nenhuma delas pode derrubar a análise já gravada.
  if (conv.contactId) {
    await applyTemperatureTag(db, accountId, conv.contactId, analysis.temperatura).catch(
      (err) => console.error('[radar] tag de temperatura falhou:', err),
    )
  }
  if (analysis.escalar_humano) {
    await escalateToHuman(db, accountId, conv.id, analysis).catch((err) =>
      console.error('[radar] escalada falhou:', err),
    )
    result.escaladas++
  }
}

// ---------------------------------------------------------------------------
// Prompt

function buildRadarPrompt(
  settings: RadarSettings,
  previous: { temperatura?: string; interesse?: string | null; resumo?: string | null } | null,
  now: Date,
): string {
  const hoje = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  const diaSemana = now.toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long',
  })

  return [
    'Você é o Radar de Leads da Oficina Informática (loja de manutenção e venda de notebooks e computadores em Canoas/Sapucaia do Sul, RS).',
    'Sua função é LER a conversa com o cliente e devolver um dossiê estruturado. Você não conversa com ninguém — apenas analisa.',
    '',
    settings.contexto_negocio ? `SOBRE O NEGÓCIO:\n${settings.contexto_negocio}\n` : '',
    'COMO CLASSIFICAR A TEMPERATURA (critérios do dono da loja):',
    `- QUENTE: ${settings.criterios_quente?.trim() || DEFAULT_CRITERIOS.quente}`,
    `- MORNO: ${settings.criterios_morno?.trim() || DEFAULT_CRITERIOS.morno}`,
    `- FRIO: ${settings.criterios_frio?.trim() || DEFAULT_CRITERIOS.frio}`,
    '- INDEFINIDO: não há sinal suficiente para classificar.',
    '',
    previous
      ? `DOSSIÊ ANTERIOR (atualize, não repita):\n- temperatura: ${previous.temperatura}\n- interesse: ${previous.interesse ?? '—'}\n- resumo: ${previous.resumo ?? '—'}\n`
      : 'Este lead ainda não tem dossiê — monte o primeiro.\n',
    `HOJE É ${diaSemana}, ${hoje} (fuso de Brasília). Use esta data para resolver referências como "dia 20", "semana que vem", "sábado".`,
    '',
    'O QUE EXTRAIR:',
    '- temperatura: aplique os critérios acima.',
    '- interesse: em UMA frase, o que o cliente quer (ex.: "notebook gamer até R$ 3.500 para produção musical"). null se não der para saber.',
    '- resumo: 1 a 3 frases sobre onde a negociação está AGORA.',
    '- momentos_novos: fatos NOVOS e relevantes ditos pelo cliente (nunca repita o que já está no dossiê anterior). Tipos: promessa_data (deu data/prazo), objecao (preço alto, precisa pensar, vai comparar), orcamento (quanto pode pagar/parcelar), interesse (o que procura), pessoal (contexto útil: profissão, uso, família). Texto curto, em terceira pessoa.',
    '- proximo_contato: SE o cliente deu uma data ou prazo para decidir/voltar/comprar, converta para data ISO 8601 completa (use 10:00 no fuso de Brasília como horário padrão) e explique o motivo. null se não houve promessa. IMPORTANTE: só use datas FUTURAS.',
    '- escalar_humano: true quando o lead ESQUENTOU e um atendente deve assumir AGORA (ex.: "consegui o dinheiro", "vou aí hoje", "pode separar que eu levo", pediu para fechar). false no resto.',
    '',
    'RESPONDA APENAS com JSON válido, sem markdown, neste formato:',
    '{"temperatura":"quente|morno|frio|indefinido","interesse":"texto ou null","resumo":"texto ou null","momentos_novos":[{"tipo":"promessa_data","texto":"disse que compra dia 20"}],"proximo_contato":{"quando":"2026-08-20T13:00:00Z","motivo":"cliente disse que compra no dia 20"},"escalar_humano":false,"escalar_motivo":null}',
  ]
    .filter(Boolean)
    .join('\n')
}

// ---------------------------------------------------------------------------
// Parser defensivo

/** Extrai o JSON da resposta da IA. Retorna null quando ilegível. */
export function parseRadarAnalysis(
  raw: string,
  now: Date = new Date(),
): RadarAnalysis | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }

  const temperaturaRaw = String(parsed.temperatura ?? '').toLowerCase()
  const temperatura: Temperatura = (
    ['quente', 'morno', 'frio', 'indefinido'] as const
  ).includes(temperaturaRaw as Temperatura)
    ? (temperaturaRaw as Temperatura)
    : 'indefinido'

  const nowIso = now.toISOString()
  const momentos_novos: Momento[] = Array.isArray(parsed.momentos_novos)
    ? (parsed.momentos_novos as unknown[])
        .map((m) => {
          const item = m as { tipo?: unknown; texto?: unknown; em?: unknown }
          const texto = typeof item.texto === 'string' ? item.texto.trim() : ''
          const tipo = String(item.tipo ?? 'interesse')
          if (!texto) return null
          return {
            em: typeof item.em === 'string' ? item.em : nowIso,
            tipo: (MOMENTO_TIPOS.has(tipo) ? tipo : 'interesse') as MomentoTipo,
            texto,
          }
        })
        .filter((m): m is Momento => m !== null)
        .slice(0, 8)
    : []

  // Promessa: só aceita data futura e parseável — uma data no passado
  // (ou inventada) faria o agente cobrar imediatamente.
  let proximo_contato: RadarAnalysis['proximo_contato'] = null
  const pc = parsed.proximo_contato as
    | { quando?: unknown; motivo?: unknown }
    | null
    | undefined
  if (pc && typeof pc.quando === 'string') {
    const when = new Date(pc.quando)
    if (!Number.isNaN(when.getTime()) && when.getTime() > now.getTime()) {
      proximo_contato = {
        quando: when.toISOString(),
        motivo:
          typeof pc.motivo === 'string' && pc.motivo.trim()
            ? pc.motivo.trim()
            : 'cliente indicou uma data',
      }
    }
  }

  const asText = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null'
      ? v.trim()
      : null

  return {
    temperatura,
    interesse: asText(parsed.interesse),
    resumo: asText(parsed.resumo),
    momentos_novos,
    proximo_contato,
    escalar_humano: parsed.escalar_humano === true,
    escalar_motivo: asText(parsed.escalar_motivo),
  }
}

/** Momentos vindos do banco (JSONB) — descarta lixo defensivamente. */
export function normalizeMomentos(raw: unknown): Momento[] {
  if (!Array.isArray(raw)) return []
  return (raw as unknown[])
    .map((m) => {
      const item = m as { em?: unknown; tipo?: unknown; texto?: unknown }
      if (typeof item?.texto !== 'string' || !item.texto.trim()) return null
      return {
        em: typeof item.em === 'string' ? item.em : new Date(0).toISOString(),
        tipo: (MOMENTO_TIPOS.has(String(item.tipo))
          ? String(item.tipo)
          : 'interesse') as MomentoTipo,
        texto: item.texto.trim(),
      }
    })
    .filter((m): m is Momento => m !== null)
}

// ---------------------------------------------------------------------------
// Ações

const TEMPERATURE_TAGS: Record<Exclude<Temperatura, 'indefinido'>, { name: string; color: string }> =
  {
    quente: { name: 'quente', color: '#ef4444' },
    morno: { name: 'morno', color: '#f59e0b' },
    frio: { name: 'frio', color: '#38bdf8' },
  }

/**
 * Reflete a temperatura como tag do contato — assim ela aparece na
 * lateral, nos filtros do inbox e nos públicos de transmissão. Troca
 * exclusiva: entra uma, saem as outras duas.
 */
async function applyTemperatureTag(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  temperatura: Temperatura,
): Promise<void> {
  const names = Object.values(TEMPERATURE_TAGS).map((t) => t.name)
  const { data: existingTags } = await db
    .from('tags')
    .select('id, name')
    .eq('account_id', accountId)
    .in('name', names)

  const byName = new Map(
    (existingTags ?? []).map((t) => [t.name as string, t.id as string]),
  )
  const otherIds = [...byName.entries()]
    .filter(([name]) => name !== temperatura)
    .map(([, id]) => id)
  if (otherIds.length > 0) {
    await db
      .from('contact_tags')
      .delete()
      .eq('contact_id', contactId)
      .in('tag_id', otherIds)
  }

  if (temperatura === 'indefinido') return

  let tagId = byName.get(temperatura)
  if (!tagId) {
    // Precisa de um dono para a linha (tags.user_id é NOT NULL).
    const { data: owner } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (!owner?.user_id) return
    const { data: created } = await db
      .from('tags')
      .insert({
        account_id: accountId,
        user_id: owner.user_id,
        name: TEMPERATURE_TAGS[temperatura].name,
        color: TEMPERATURE_TAGS[temperatura].color,
      })
      .select('id')
      .single()
    tagId = created?.id as string | undefined
  }
  if (!tagId) return

  await db
    .from('contact_tags')
    .upsert(
      { contact_id: contactId, tag_id: tagId },
      { onConflict: 'contact_id,tag_id', ignoreDuplicates: true },
    )
}

/** Lead esquentou: avisa a equipe no sino com o motivo e o link do chat. */
async function escalateToHuman(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  analysis: RadarAnalysis,
): Promise<void> {
  const { data: conversation } = await db
    .from('conversations')
    .select('contact_id, contact:contacts(name, phone)')
    .eq('id', conversationId)
    .maybeSingle()
  const contactRaw = conversation?.contact
  const contact = Array.isArray(contactRaw) ? contactRaw[0] : contactRaw
  const nome = contact?.name || contact?.phone || 'Um cliente'

  const { data: recipients } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    // `account_role` (enum da 017) é o papel real; `role` é a coluna
    // TEXT legada, que vale 'user' para todo mundo.
    .in('account_role', ['owner', 'admin', 'agent'])

  const rows = (recipients ?? []).map((r: { user_id: string }) => ({
    account_id: accountId,
    user_id: r.user_id,
    type: 'system_alert',
    conversation_id: conversationId,
    contact_id: conversation?.contact_id ?? null,
    title: `🔥 ${nome} esquentou — atenda agora`,
    body:
      (analysis.escalar_motivo ?? 'O Radar identificou intenção de compra.') +
      (analysis.interesse ? ` Interesse: ${analysis.interesse}.` : ''),
  }))
  if (rows.length > 0) await db.from('notifications').insert(rows)
}
