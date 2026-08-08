/**
 * Agente de follow-up (FASE 5, CLAUDE.md §10) — o coração do projeto.
 *
 * "Nenhuma conversa comercial morre no esquecimento." Este módulo:
 *   1. DETECTA os 4 cenários (equipamento pronto não retirado,
 *      pós-venda, orçamento sem resposta, lead frio no funil);
 *   2. aplica as GUARDAS anti-spam do §10/§11 (1 pendente por conversa,
 *      cadência mínima entre follow-ups ao mesmo contato, máximo de
 *      tentativas por cenário, tag nao-contatar);
 *   3. pede à IA (módulo ai/ existente, chave BYO da conta) que REDIJA
 *      a mensagem — a IA pode decidir NÃO enviar (ex.: cliente já disse
 *      que vem buscar amanhã);
 *   4. EXECUTA: cenários automáticos saem na hora (auto_sent); os
 *      delicados entram como pending na fila de /followups.
 *
 * Disparado pelo relógio do servidor 2x ao dia em horário comercial
 * (instrumentation.ts) e pelo backstop GET /api/followups/cron.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from '@/lib/ai/config'
import { buildConversationContext } from '@/lib/ai/context'
import { retrieveKnowledge } from '@/lib/ai/knowledge'
import { generateReply } from '@/lib/ai/generate'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { normalizeMomentos } from '@/lib/insights/analyzer'
import { featureEnabled } from '@/lib/features/guard'

// ---------------------------------------------------------------------------
// Tipos e constantes

export type FollowupCenario =
  | 'equipamento_pronto'
  | 'pos_venda'
  | 'orcamento_sem_resposta'
  | 'lead_frio'
  /** O Radar ouviu o cliente prometer uma data ("compro dia 20") — §10.5. */
  | 'promessa'

/**
 * Automáticos enviam sozinhos; os demais entram na fila de aprovação.
 * 'promessa' entra aqui porque o retorno foi o PRÓPRIO cliente que
 * marcou — é o follow-up menos intrusivo que existe, e travá-lo na fila
 * quebraria o ciclo de nutrição (§10.5).
 */
const AUTO_CENARIOS: ReadonlySet<FollowupCenario> = new Set([
  'equipamento_pronto',
  'pos_venda',
  'promessa',
])

interface FollowupSettings {
  enabled: boolean
  dias_equipamento_pronto: number
  dias_pos_venda: number
  dias_orcamento: number
  dias_lead_frio: number
  cadencia_minima_dias: number
  max_tentativas: number
  last_scan_at: string | null
}

const DEFAULT_SETTINGS: FollowupSettings = {
  enabled: true,
  dias_equipamento_pronto: 3,
  dias_pos_venda: 7,
  dias_orcamento: 3,
  dias_lead_frio: 7,
  cadencia_minima_dias: 3,
  max_tentativas: 3,
  last_scan_at: null,
}

interface Candidate {
  cenario: FollowupCenario
  conversationId: string
  contactId: string
  contactName: string
  osId?: string
  dealId?: string
  /** Fatos do cenário que entram no prompt (equipamento, valor, dias parado...). */
  contexto: string
}

export interface FollowupScanResult {
  autoSent: number
  queued: number
  skippedByAi: number
  errors: number
}

let _admin: SupabaseClient | null = null
function admin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  if (!_admin) _admin = createClient(url, key)
  return _admin
}

function daysAgoIso(days: number, now: Date): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString()
}

// ---------------------------------------------------------------------------
// Varredura (entry point)

/**
 * Roda a varredura completa para todas as contas habilitadas. Idempotente
 * por desenho: as guardas impedem sugestão duplicada mesmo se rodar duas
 * vezes seguidas.
 */
export async function runFollowupScan(
  now: Date = new Date(),
): Promise<FollowupScanResult> {
  const result: FollowupScanResult = {
    autoSent: 0,
    queued: 0,
    skippedByAi: 0,
    errors: 0,
  }
  const db = admin()
  if (!db) return result

  const { data: accounts } = await db.from('accounts').select('id')
  for (const account of accounts ?? []) {
    try {
      await scanAccount(db, account.id as string, now, result)
    } catch (err) {
      result.errors++
      console.error(`[followups] varredura da conta ${account.id} falhou:`, err)
    }
  }
  return result
}

/** Hora local do negócio (RS = America/Sao_Paulo). */
function horaLocal(now: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo',
      hour: 'numeric',
      hour12: false,
    }).format(now),
  )
}

/**
 * Chamada pelo relógio do servidor a cada meia hora: só roda de verdade
 * em horário comercial (9h–18h) e no máximo a cada ~5h por conta
 * (auto-gate via last_scan_at) — na prática, ~2 varreduras por dia,
 * como pede o §10.
 */
export async function maybeRunFollowupScan(
  now: Date = new Date(),
): Promise<FollowupScanResult | null> {
  const hora = horaLocal(now)
  if (hora < 9 || hora >= 18) return null
  return runFollowupScan(now)
}

const MIN_SCAN_GAP_MS = 5 * 60 * 60_000

async function scanAccount(
  db: SupabaseClient,
  accountId: string,
  now: Date,
  result: FollowupScanResult,
): Promise<void> {
  const settings = await loadSettings(db, accountId)
  if (!settings.enabled) return
  // Central de Recursos (049) — inclui o modo manual.
  if (!(await featureEnabled(db, accountId, 'followup'))) return

  // ~2x ao dia: pula se a última varredura desta conta foi há pouco.
  if (
    settings.last_scan_at &&
    now.getTime() - new Date(settings.last_scan_at).getTime() < MIN_SCAN_GAP_MS
  ) {
    return
  }

  // Sem IA configurada não há o que redigir — o agente fica em espera.
  // requireActive: false — is_active é o interruptor do bot de
  // auto-resposta do INBOX; o agente de follow-up tem o próprio
  // (followup_settings.enabled) e só precisa da chave válida.
  const aiConfig = await loadAiConfig(db, accountId, { requireActive: false })
  if (!aiConfig) {
    console.warn(`[followups] conta ${accountId} sem IA configurada — pulando`)
    return
  }

  await db
    .from('followup_settings')
    .upsert({ account_id: accountId, last_scan_at: now.toISOString() })

  // Promessas primeiro: a data que o CLIENTE deu vale mais que qualquer
  // prazo genérico nosso. Como só cabe um follow-up pendente por
  // conversa, a ordem aqui é a ordem de prioridade real.
  const candidates = [
    ...(await detectPromessas(db, accountId, now)),
    ...(await detectEquipamentoPronto(db, accountId, settings, now)),
    ...(await detectPosVenda(db, accountId, settings, now)),
    ...(await detectOrcamentoSemResposta(db, accountId, settings, now)),
    ...(await detectLeadFrio(db, accountId, settings, now)),
  ]

  for (const candidate of candidates) {
    try {
      const allowed = await passesGuards(db, accountId, settings, candidate, now)
      if (!allowed) continue

      const generation = await generateFollowup(db, accountId, aiConfig, candidate)
      if (!generation.enviar) {
        result.skippedByAi++
        continue
      }

      if (AUTO_CENARIOS.has(candidate.cenario)) {
        await sendMessageToConversation(db, accountId, {
          conversationId: candidate.conversationId,
          messageType: 'text',
          contentText: generation.mensagem,
        })
        await insertSuggestion(db, accountId, candidate, generation, 'auto_sent', now)
        result.autoSent++
      } else {
        await insertSuggestion(db, accountId, candidate, generation, 'pending', now)
        result.queued++
      }
    } catch (err) {
      result.errors++
      console.error(
        `[followups] candidato ${candidate.cenario}/${candidate.conversationId} falhou:`,
        err,
      )
    }
  }
}

async function loadSettings(
  db: SupabaseClient,
  accountId: string,
): Promise<FollowupSettings> {
  const { data } = await db
    .from('followup_settings')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()
  return { ...DEFAULT_SETTINGS, ...(data ?? {}) }
}

// ---------------------------------------------------------------------------
// Detecção dos cenários

/** Estado ATUAL de cada OS = evento mais recente por os_id. */
async function latestOsStates(
  db: SupabaseClient,
  accountId: string,
): Promise<
  Map<
    string,
    {
      status: string | null
      contact_id: string | null
      equipamento: string | null
      valor_orcamento: number | null
      data_evento: string
    }
  >
> {
  const { data } = await db
    .from('os_events')
    .select('os_id, status, contact_id, equipamento, valor_orcamento, data_evento')
    .eq('account_id', accountId)
    .order('data_evento', { ascending: false })
    .limit(500)
  const byOs = new Map<string, NonNullable<typeof data>[number]>()
  for (const row of data ?? []) {
    if (!byOs.has(row.os_id)) byOs.set(row.os_id, row)
  }
  return byOs
}

async function conversationForContact(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<{ id: string; contactName: string } | null> {
  const { data } = await db
    .from('conversations')
    .select('id, contact:contacts(name, phone)')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!data) return null
  const contactRaw = data.contact
  const contact = Array.isArray(contactRaw) ? contactRaw[0] : contactRaw
  return {
    id: data.id,
    contactName: (contact?.name || contact?.phone || 'cliente') as string,
  }
}

function diasDesde(iso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000)
}

/**
 * Cenário 'promessa' (§10.5): o Radar gravou a data que o cliente deu
 * ("compro dia 20", "semana que vem eu vejo") e ela chegou. Marca
 * `promessa_atendida_em` na hora de enfileirar para não repetir — uma
 * promessa nova reabre a janela (o analisador limpa o campo).
 */
async function detectPromessas(
  db: SupabaseClient,
  accountId: string,
  now: Date,
): Promise<Candidate[]> {
  const out: Candidate[] = []
  const { data: due } = await db
    .from('conversation_insights')
    .select(
      'conversation_id, contact_id, interesse, proximo_contato_em, proximo_contato_motivo, resumo',
    )
    .eq('account_id', accountId)
    .not('proximo_contato_em', 'is', null)
    .is('promessa_atendida_em', null)
    .lte('proximo_contato_em', now.toISOString())
    .limit(30)

  for (const row of due ?? []) {
    if (!row.contact_id) continue
    const conv = await conversationForContact(
      db,
      accountId,
      row.contact_id as string,
    )
    if (!conv) continue

    // Consome a promessa antes de gerar: se a IA falhar depois, o
    // cliente não recebe a mesma cobrança em toda varredura.
    await db
      .from('conversation_insights')
      .update({ promessa_atendida_em: now.toISOString() })
      .eq('conversation_id', row.conversation_id as string)

    out.push({
      cenario: 'promessa',
      conversationId: row.conversation_id as string,
      contactId: row.contact_id as string,
      contactName: conv.contactName,
      contexto: `O PRÓPRIO CLIENTE indicou esta data: ${row.proximo_contato_motivo ?? 'disse que voltaria agora'}.${row.interesse ? ` Interesse: ${row.interesse}.` : ''}${row.resumo ? ` Situação: ${row.resumo}` : ''}`,
    })
  }
  return out
}

async function detectEquipamentoPronto(
  db: SupabaseClient,
  accountId: string,
  settings: FollowupSettings,
  now: Date,
): Promise<Candidate[]> {
  const out: Candidate[] = []
  const states = await latestOsStates(db, accountId)
  for (const [osId, st] of states) {
    if (st.status !== 'pronto' || !st.contact_id) continue
    const dias = diasDesde(st.data_evento, now)
    if (dias < settings.dias_equipamento_pronto) continue
    const conv = await conversationForContact(db, accountId, st.contact_id)
    if (!conv) continue
    out.push({
      cenario: 'equipamento_pronto',
      conversationId: conv.id,
      contactId: st.contact_id,
      contactName: conv.contactName,
      osId,
      contexto: `OS ${osId}: ${st.equipamento ?? 'equipamento'} está PRONTO para retirada há ${dias} dias${st.valor_orcamento != null ? ` (valor: R$ ${st.valor_orcamento})` : ''}.`,
    })
  }
  return out
}

async function detectPosVenda(
  db: SupabaseClient,
  accountId: string,
  settings: FollowupSettings,
  now: Date,
): Promise<Candidate[]> {
  const out: Candidate[] = []
  const states = await latestOsStates(db, accountId)
  for (const [osId, st] of states) {
    if (st.status !== 'entregue' || !st.contact_id) continue
    const dias = diasDesde(st.data_evento, now)
    // Janela: dispara a partir de N dias, mas não ressuscita entregas
    // muito antigas (2× N) — as tentativas/cadência seguram o meio.
    if (dias < settings.dias_pos_venda || dias > settings.dias_pos_venda * 2) continue
    const conv = await conversationForContact(db, accountId, st.contact_id)
    if (!conv) continue
    out.push({
      cenario: 'pos_venda',
      conversationId: conv.id,
      contactId: st.contact_id,
      contactName: conv.contactName,
      osId,
      contexto: `OS ${osId}: ${st.equipamento ?? 'equipamento'} foi ENTREGUE há ${dias} dias — hora de saber se está tudo bem (pesquisa de satisfação leve).`,
    })
  }
  return out
}

async function detectOrcamentoSemResposta(
  db: SupabaseClient,
  accountId: string,
  settings: FollowupSettings,
  now: Date,
): Promise<Candidate[]> {
  const out: Candidate[] = []
  const states = await latestOsStates(db, accountId)
  for (const [osId, st] of states) {
    if (st.status !== 'orcamento_enviado' || !st.contact_id) continue
    if (diasDesde(st.data_evento, now) < settings.dias_orcamento) continue
    const conv = await conversationForContact(db, accountId, st.contact_id)
    if (!conv) continue
    // "Última mensagem é nossa": cliente não respondeu desde o orçamento.
    const { data: lastMsg } = await db
      .from('messages')
      .select('sender_type, created_at')
      .eq('conversation_id', conv.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (lastMsg?.sender_type === 'customer') continue
    out.push({
      cenario: 'orcamento_sem_resposta',
      conversationId: conv.id,
      contactId: st.contact_id,
      contactName: conv.contactName,
      osId,
      contexto: `OS ${osId}: orçamento${st.valor_orcamento != null ? ` de R$ ${st.valor_orcamento}` : ''} de ${st.equipamento ?? 'equipamento'} enviado há ${diasDesde(st.data_evento, now)} dias e o cliente ainda não respondeu.`,
    })
  }
  return out
}

async function detectLeadFrio(
  db: SupabaseClient,
  accountId: string,
  settings: FollowupSettings,
  now: Date,
): Promise<Candidate[]> {
  const out: Candidate[] = []
  const { data: deals } = await db
    .from('deals')
    .select('id, title, value, contact_id, conversation_id, updated_at, stage:pipeline_stages(name)')
    .eq('account_id', accountId)
    .eq('status', 'active')
    .lt('updated_at', daysAgoIso(settings.dias_lead_frio, now))
    .limit(100)
  for (const deal of deals ?? []) {
    if (!deal.contact_id) continue
    const conv = deal.conversation_id
      ? {
          id: deal.conversation_id as string,
          contactName: '',
        }
      : await conversationForContact(db, accountId, deal.contact_id as string)
    if (!conv) continue
    if (!conv.contactName) {
      const named = await conversationForContact(db, accountId, deal.contact_id as string)
      conv.contactName = named?.contactName ?? 'cliente'
    }
    const stageRaw = deal.stage
    const stage = Array.isArray(stageRaw) ? stageRaw[0] : stageRaw
    out.push({
      cenario: 'lead_frio',
      conversationId: conv.id,
      contactId: deal.contact_id as string,
      contactName: conv.contactName,
      dealId: deal.id as string,
      contexto: `Negócio "${deal.title}" (R$ ${deal.value}) está parado no estágio "${stage?.name ?? '?'}" há ${diasDesde(deal.updated_at as string, now)} dias, sem movimentação.`,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Guardas (§10 + §11)

async function passesGuards(
  db: SupabaseClient,
  accountId: string,
  settings: FollowupSettings,
  candidate: Candidate,
  now: Date,
): Promise<boolean> {
  // Opt-out: tag nao-contatar suprime o contato de tudo automatizado.
  const { data: optOut } = await db
    .from('contact_tags')
    .select('id, tags!inner(name)')
    .eq('contact_id', candidate.contactId)
    .eq('tags.name', 'nao-contatar')
    .limit(1)
  if (optOut && optOut.length > 0) return false

  // Máximo 1 pendente por conversa.
  const { data: pending } = await db
    .from('followup_suggestions')
    .select('id')
    .eq('conversation_id', candidate.conversationId)
    .eq('status', 'pending')
    .limit(1)
  if (pending && pending.length > 0) return false

  // Cadência mínima entre follow-ups ENVIADOS ao mesmo contato.
  const { data: recent } = await db
    .from('followup_suggestions')
    .select('id')
    .eq('contact_id', candidate.contactId)
    .in('status', ['sent', 'auto_sent'])
    .gte('decided_at', daysAgoIso(settings.cadencia_minima_dias, now))
    .limit(1)
  if (recent && recent.length > 0) return false

  // Máximo de tentativas por cenário (depois disso, silêncio).
  const { count } = await db
    .from('followup_suggestions')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', candidate.conversationId)
    .eq('cenario', candidate.cenario)
    .neq('status', 'discarded')
  if ((count ?? 0) >= settings.max_tentativas) return false

  return true
}

// ---------------------------------------------------------------------------
// Geração (Claude via módulo ai/ — chave BYO da conta)

interface Generation {
  enviar: boolean
  mensagem: string
  justificativa: string
}

const CENARIO_INSTRUCAO: Record<FollowupCenario, string> = {
  equipamento_pronto:
    'Avisar (ou relembrar) com gentileza que o equipamento está pronto para retirada, sem pressionar.',
  pos_venda:
    'Pós-venda leve: perguntar se está tudo bem com o equipamento entregue e se pode ajudar em algo. Curto e caloroso.',
  orcamento_sem_resposta:
    'Retomar o orçamento enviado com leveza, colocando-se à disposição para dúvidas — nunca soar cobrança.',
  lead_frio:
    'Reaquecer a conversa parada de forma natural, referenciando o interesse original do cliente.',
  promessa:
    'Retomar exatamente como combinado com o cliente — ele mesmo pediu para falar agora. Cite o combinado com naturalidade ("como tinha combinado contigo"), sem soar cobrança e sem repetir tudo o que já foi dito.',
}

/**
 * Bloco de contexto vindo do Radar de Leads. Vazio quando a conversa
 * ainda não foi analisada — o agente segue funcionando sem ele.
 */
async function buildDossieBlock(
  db: SupabaseClient,
  conversationId: string,
): Promise<string> {
  const { data } = await db
    .from('conversation_insights')
    .select('temperatura, interesse, resumo, momentos')
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (!data) return ''

  const momentos = normalizeMomentos(data.momentos)
    .slice(-6)
    .map((m) => `  • ${m.texto}`)
    .join('\n')

  return [
    '',
    'O QUE JÁ SABEMOS DESTE CLIENTE (dossiê do Radar):',
    `- Temperatura: ${data.temperatura}`,
    data.interesse ? `- Interesse: ${data.interesse}` : '',
    data.resumo ? `- Situação: ${data.resumo}` : '',
    momentos ? `- Momentos da conversa:\n${momentos}` : '',
    'Use isso para soar como quem acompanhou o cliente — sem repetir literalmente o que ele disse.',
  ]
    .filter(Boolean)
    .join('\n')
}

async function generateFollowup(
  db: SupabaseClient,
  accountId: string,
  aiConfig: NonNullable<Awaited<ReturnType<typeof loadAiConfig>>>,
  candidate: Candidate,
): Promise<Generation> {
  const history = await buildConversationContext(db, candidate.conversationId, 15)
  const knowledge = await retrieveKnowledge(
    db,
    accountId,
    aiConfig,
    candidate.contexto,
    3,
  ).catch(() => [] as string[])

  // Dossiê do Radar (§10.5): temperatura, interesse e momentos-chave que
  // a IA já extraiu da conversa. É o que faz o follow-up soar como quem
  // acompanhou o cliente, não como um robô que só viu o gatilho.
  const dossie = await buildDossieBlock(db, candidate.conversationId)

  const systemPrompt = [
    'Você é o agente de follow-up da Oficina Informática (loja de manutenção e venda de notebooks em Canoas/Sapucaia do Sul, RS).',
    'Sua tarefa: decidir se cabe um follow-up AGORA e, se sim, redigir a mensagem de WhatsApp.',
    '',
    `CENÁRIO: ${CENARIO_INSTRUCAO[candidate.cenario]}`,
    dossie,
    `FATOS: ${candidate.contexto}`,
    knowledge.length
      ? `SOBRE O NEGÓCIO:\n${knowledge.map((k) => `- ${k}`).join('\n')}`
      : '',
    '',
    'REGRAS DA MENSAGEM:',
    `- Português brasileiro, tom informal-profissional, curta (2 a 4 frases), personalizada com o nome ${candidate.contactName ? `(${candidate.contactName})` : ''} quando soar natural. Sem cara de robô, sem "prezado", no máximo 1 emoji.`,
    '- Se o histórico mostrar que o follow-up NÃO cabe (ex.: cliente já disse que vem buscar, já respondeu, pediu para não ser incomodado, assunto resolvido), decida NÃO enviar.',
    '',
    'RESPONDA APENAS com JSON válido, sem markdown:',
    '{"enviar": true|false, "mensagem": "texto da mensagem (vazio se enviar=false)", "justificativa": "1 frase explicando a decisão"}',
  ]
    .filter(Boolean)
    .join('\n')

  // A conversa quase sempre termina em mensagem NOSSA (é a natureza do
  // follow-up) — e um histórico terminando no turno do assistente vira
  // "prefill" na API da Anthropic (o modelo tenta CONTINUAR a última
  // frase e devolve vazio). Fechamos sempre com um turno de usuário
  // instruindo a avaliação.
  const { text } = await generateReply({
    config: aiConfig,
    systemPrompt,
    messages: [
      ...(history.length
        ? history
        : [{ role: 'user' as const, content: '(sem histórico de mensagens ainda)' }]),
      {
        role: 'user' as const,
        content:
          '[instrução do sistema — o cliente NÃO escreveu isto] Avalie o cenário e as regras do prompt e responda AGORA apenas com o JSON pedido.',
      },
    ],
  })

  return parseGeneration(text)
}

/** Parser defensivo do JSON da IA (aceita cercas de código e ruído leve). */
export function parseGeneration(raw: string): Generation {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    return { enviar: false, mensagem: '', justificativa: 'Resposta da IA fora do formato esperado.' }
  }
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Partial<Generation>
    const mensagem = typeof parsed.mensagem === 'string' ? parsed.mensagem.trim() : ''
    return {
      enviar: parsed.enviar === true && mensagem.length > 0,
      mensagem,
      justificativa:
        typeof parsed.justificativa === 'string' && parsed.justificativa.trim()
          ? parsed.justificativa.trim()
          : 'Sem justificativa.',
    }
  } catch {
    return { enviar: false, mensagem: '', justificativa: 'JSON da IA inválido.' }
  }
}

// ---------------------------------------------------------------------------
// Persistência

async function insertSuggestion(
  db: SupabaseClient,
  accountId: string,
  candidate: Candidate,
  generation: Generation,
  status: 'pending' | 'auto_sent',
  now: Date,
): Promise<void> {
  const { error } = await db.from('followup_suggestions').insert({
    account_id: accountId,
    conversation_id: candidate.conversationId,
    contact_id: candidate.contactId,
    os_id: candidate.osId ?? null,
    deal_id: candidate.dealId ?? null,
    cenario: candidate.cenario,
    mensagem_sugerida: generation.mensagem,
    justificativa_ia: generation.justificativa,
    status,
    mensagem_final: status === 'auto_sent' ? generation.mensagem : null,
    decided_at: status === 'auto_sent' ? now.toISOString() : null,
  })
  if (error) throw new Error(error.message)
}
