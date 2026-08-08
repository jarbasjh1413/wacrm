/**
 * Diagnóstico da Central de Recursos (049).
 *
 * GET  — estado de saúde de cada recurso: está configurado? tem chave?
 *        quando rodou pela última vez? Alimenta os selos da tela.
 * POST — "Testar agora": roda a checagem funcional do recurso pedido
 *        (bate na Evolution, chama a IA de verdade) e devolve o veredito.
 *
 * A ideia do Jarbas: "no momento em que liga, testa se está funcionando".
 */

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveAccountId, readEvolutionEnv } from '@/lib/whatsapp/evolution-config'
import { getConnectionState } from '@/lib/whatsapp/evolution-api'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'

export const dynamic = 'force-dynamic'

type Health = 'ok' | 'off' | 'unconfigured' | 'error'

interface FeatureStatus {
  feature: string
  health: Health
  detail: string | null
  lastActivity: string | null
}

export async function GET() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json({ error: 'Sem conta vinculada' }, { status: 400 })
    }

    const [aiConfig, whatsapp, followup, radar, broadcasts, scheduled, automations] =
      await Promise.all([
        loadAiConfig(supabase, accountId, { requireActive: false }),
        supabase
          .from('whatsapp_config')
          .select('status, evolution_instance_name')
          .eq('engine', 'evolution')
          .limit(1)
          .maybeSingle(),
        supabase
          .from('followup_suggestions')
          .select('created_at')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('conversation_insights')
          .select('ultima_analise_em')
          .not('ultima_analise_em', 'is', null)
          .order('ultima_analise_em', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('broadcasts')
          .select('created_at')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('scheduled_messages')
          .select('created_at')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('automations')
          .select('id', { count: 'exact', head: true })
          .eq('is_active', true),
      ])

    const hasAi = Boolean(aiConfig?.apiKey)
    const aiDetail = hasAi
      ? `${aiConfig?.provider} · ${aiConfig?.model}`
      : 'Configure a chave em Agentes de IA'

    const statuses: FeatureStatus[] = [
      {
        feature: 'radar',
        health: hasAi ? 'ok' : 'unconfigured',
        detail: aiDetail,
        lastActivity: radar.data?.ultima_analise_em ?? null,
      },
      {
        feature: 'followup',
        health: hasAi ? 'ok' : 'unconfigured',
        detail: aiDetail,
        lastActivity: followup.data?.created_at ?? null,
      },
      {
        feature: 'auto_reply',
        health: hasAi
          ? aiConfig?.autoReplyEnabled
            ? 'ok'
            : 'off'
          : 'unconfigured',
        detail: hasAi
          ? aiConfig?.autoReplyEnabled
            ? aiDetail
            : 'Ligue também em Agentes de IA → Resposta automática'
          : aiDetail,
        lastActivity: null,
      },
      {
        feature: 'automations',
        health: 'ok',
        detail: `${automations.count ?? 0} automação(ões) ativa(s)`,
        lastActivity: null,
      },
      { feature: 'flows', health: 'ok', detail: null, lastActivity: null },
      {
        feature: 'broadcasts',
        health: whatsapp.data?.status === 'connected' ? 'ok' : 'error',
        detail:
          whatsapp.data?.status === 'connected'
            ? 'WhatsApp conectado'
            : 'WhatsApp desconectado — veja Configurações → WhatsApp',
        lastActivity: broadcasts.data?.created_at ?? null,
      },
      {
        feature: 'scheduled',
        health: whatsapp.data?.status === 'connected' ? 'ok' : 'error',
        detail: null,
        lastActivity: scheduled.data?.created_at ?? null,
      },
      {
        feature: 'transcription',
        health: 'unconfigured',
        detail: 'Ainda não implementado — ver docs/multimidia-ia.md',
        lastActivity: null,
      },
      {
        feature: 'vision',
        health: 'unconfigured',
        detail: 'Ainda não implementado — ver docs/multimidia-ia.md',
        lastActivity: null,
      },
    ]

    return NextResponse.json({ statuses })
  } catch (err) {
    console.error('[features/status] GET failed:', err)
    return NextResponse.json({ error: 'Falha ao ler o status' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json({ error: 'Sem conta vinculada' }, { status: 400 })
    }

    const { feature } = await request.json().catch(() => ({ feature: null }))

    // Recursos de IA: uma chamada real e mínima ao provedor. É o único
    // teste que prova que a chave funciona (existir no banco não basta).
    if (['radar', 'followup', 'auto_reply'].includes(feature)) {
      const config = await loadAiConfig(supabase, accountId, {
        requireActive: false,
      })
      if (!config) {
        return NextResponse.json({
          ok: false,
          message: 'Nenhuma chave de IA configurada em Agentes de IA.',
        })
      }
      try {
        const { text } = await generateReply({
          config,
          systemPrompt:
            'Responda exatamente com a palavra OK. Nada mais, sem pontuação.',
          messages: [{ role: 'user', content: 'teste de conexão' }],
        })
        return NextResponse.json({
          ok: true,
          message: `IA respondeu (${config.model}): ${text.trim().slice(0, 40)}`,
        })
      } catch (err) {
        return NextResponse.json({
          ok: false,
          message: err instanceof Error ? err.message : 'Falha ao chamar a IA',
        })
      }
    }

    // Recursos de envio: a pergunta que importa é se o WhatsApp responde.
    if (['broadcasts', 'scheduled', 'automations', 'flows'].includes(feature)) {
      const { data: config } = await supabase
        .from('whatsapp_config')
        .select('evolution_instance_name')
        .eq('engine', 'evolution')
        .limit(1)
        .maybeSingle()
      const env = readEvolutionEnv()
      if (!config?.evolution_instance_name || !env) {
        return NextResponse.json({
          ok: false,
          message: 'Nenhum número de WhatsApp conectado.',
        })
      }
      try {
        const state = await getConnectionState({
          baseUrl: env.baseUrl,
          apikey: env.globalApikey,
          instanceName: config.evolution_instance_name,
        })
        return NextResponse.json({
          ok: state === 'open',
          message:
            state === 'open'
              ? 'WhatsApp conectado e respondendo.'
              : `WhatsApp em estado "${state}".`,
        })
      } catch (err) {
        return NextResponse.json({
          ok: false,
          message: err instanceof Error ? err.message : 'Evolution não respondeu',
        })
      }
    }

    return NextResponse.json({
      ok: false,
      message: 'Este recurso ainda não tem teste automático.',
    })
  } catch (err) {
    console.error('[features/status] POST failed:', err)
    return NextResponse.json({ error: 'Falha ao testar' }, { status: 500 })
  }
}
