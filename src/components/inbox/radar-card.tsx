'use client';

// Card do Radar de Leads (FASE 6, §10.5) — o "bate o olho e entende"
// no topo da lateral da conversa: temperatura em cor, o que o cliente
// quer, os momentos-chave que a IA capturou e o próximo contato
// prometido. Sem dossiê ainda, o card não aparece (nada de moldura
// vazia ocupando o espaço nobre).

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useTranslations } from 'next-intl';
import {
  CalendarClock,
  ChevronDown,
  Flame,
  History,
  Loader2,
  Radar,
  Snowflake,
  Sun,
  HelpCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatMediumDate, formatMediumDateTime } from '@/lib/app-locale';
import { cn } from '@/lib/utils';

type Temperatura = 'quente' | 'morno' | 'frio' | 'indefinido';
type Intencao =
  | 'compra'
  | 'assistencia'
  | 'orcamento'
  | 'informacao'
  | 'pos_venda'
  | 'outro'
  | 'indefinido';

const TEMPERATURAS: Temperatura[] = ['quente', 'morno', 'frio', 'indefinido'];
const INTENCOES: Intencao[] = [
  'compra',
  'assistencia',
  'orcamento',
  'informacao',
  'pos_venda',
  'outro',
  'indefinido',
];

/** Emoji por intenção — leitura instantânea do tipo de atendimento. */
const INTENCAO_EMOJI: Record<Intencao, string> = {
  compra: '🛒',
  assistencia: '🔧',
  orcamento: '🧾',
  informacao: 'ℹ️',
  pos_venda: '🤝',
  outro: '💬',
  indefinido: '❓',
};

interface Momento {
  em: string;
  tipo: string;
  texto: string;
}

/** Um ponto da jornada — momento da IA, OS ou follow-up enviado. */
interface JourneyEvent {
  em: string;
  icone: string;
  texto: string;
  detalhe?: string;
}

interface InsightRow {
  temperatura: Temperatura;
  intencao: Intencao;
  interesse: string | null;
  resumo: string | null;
  momentos: Momento[] | null;
  proximo_contato_em: string | null;
  proximo_contato_motivo: string | null;
  ultima_analise_em: string | null;
}

const TEMPERATURA_META: Record<
  Temperatura,
  { icon: typeof Flame; chip: string; dot: string }
> = {
  quente: {
    icon: Flame,
    chip: 'border-red-500/30 bg-red-500/10 text-red-400',
    dot: 'bg-red-500',
  },
  morno: {
    icon: Sun,
    chip: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
    dot: 'bg-amber-500',
  },
  frio: {
    icon: Snowflake,
    chip: 'border-sky-500/30 bg-sky-500/10 text-sky-400',
    dot: 'bg-sky-500',
  },
  indefinido: {
    icon: HelpCircle,
    chip: 'border-border bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground',
  },
};

/** Ícone por tipo de momento — leitura rápida da linha do tempo. */
const MOMENTO_ICON: Record<string, string> = {
  promessa_data: '📅',
  objecao: '⚠️',
  orcamento: '💰',
  interesse: '🎯',
  pessoal: '👤',
};

export function RadarCard({ conversationId }: { conversationId: string }) {
  const t = useTranslations('Inbox.radar');
  const supabase = createClient();
  const [insight, setInsight] = useState<InsightRow | null>(null);
  const [saving, setSaving] = useState<'temperatura' | 'intencao' | null>(null);

  // Jornada expansível (048): a história completa do cliente aqui
  // dentro, sem trocar de tela. Carregada só quando o agente abre.
  const [journeyOpen, setJourneyOpen] = useState(false);
  const [journey, setJourney] = useState<JourneyEvent[] | null>(null);

  const toggleJourney = useCallback(async () => {
    const opening = !journeyOpen;
    setJourneyOpen(opening);
    if (!opening || journey !== null) return;

    const { data: conv } = await supabase
      .from('conversations')
      .select('contact_id')
      .eq('id', conversationId)
      .maybeSingle();

    const [osRes, followRes] = await Promise.all([
      conv?.contact_id
        ? supabase
            .from('os_events')
            .select('os_id, status, equipamento, data_evento')
            .eq('contact_id', conv.contact_id)
            .order('data_evento', { ascending: false })
            .limit(30)
        : Promise.resolve({ data: [] }),
      supabase
        .from('followup_suggestions')
        .select('cenario, mensagem_final, mensagem_sugerida, decided_at, created_at')
        .eq('conversation_id', conversationId)
        .in('status', ['sent', 'edited', 'auto_sent'])
        .order('created_at', { ascending: false })
        .limit(30),
    ]);

    const eventos: JourneyEvent[] = [
      ...((insight?.momentos ?? []) as Momento[]).map((m) => ({
        em: m.em,
        icone: MOMENTO_ICON[m.tipo] ?? '•',
        texto: m.texto,
      })),
      ...((osRes.data ?? []) as Record<string, unknown>[]).map((o) => ({
        em: o.data_evento as string,
        icone: '🔧',
        texto: `OS ${o.os_id}${o.status ? ` — ${String(o.status).replaceAll('_', ' ')}` : ''}`,
        detalhe: (o.equipamento as string | null) ?? undefined,
      })),
      ...((followRes.data ?? []) as Record<string, unknown>[]).map((f) => ({
        em: (f.decided_at as string) ?? (f.created_at as string),
        icone: '🤖',
        texto: t('followupSent'),
        detalhe: ((f.mensagem_final ?? f.mensagem_sugerida) as string) ?? undefined,
      })),
    ].sort((a, b) => (a.em > b.em ? -1 : 1));

    setJourney(eventos);
  }, [journeyOpen, journey, supabase, conversationId, insight, t]);

  const fetchInsight = useCallback(async () => {
    const { data } = await supabase
      .from('conversation_insights')
      .select(
        'temperatura, intencao, interesse, resumo, momentos, proximo_contato_em, proximo_contato_motivo, ultima_analise_em',
      )
      .eq('conversation_id', conversationId)
      .maybeSingle();
    setInsight((data as InsightRow) ?? null);
  }, [supabase, conversationId]);

  useEffect(() => {
    // setState acontece pós-await, como nas demais telas.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchInsight();
  }, [fetchInsight]);

  // O analisador roda no servidor; realtime mantém o card fresco sem
  // o agente precisar recarregar a página.
  useEffect(() => {
    const channel = supabase
      .channel(`radar:${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'conversation_insights',
          filter: `conversation_id=eq.${conversationId}`,
        },
        () => void fetchInsight(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, conversationId, fetchInsight]);

  /**
   * Correção humana (047): o atendente discorda, ajusta aqui, e a
   * escolha (a) fixa o campo contra a IA, (b) reetiqueta o contato e
   * (c) vira exemplo no prompt das próximas análises da conta.
   */
  async function classify(campo: 'temperatura' | 'intencao', valor: string) {
    if (!insight || insight[campo] === valor) return;
    const anterior = insight[campo];
    setInsight({ ...insight, [campo]: valor } as InsightRow);
    setSaving(campo);
    try {
      const res = await fetch(`/api/radar/${conversationId}/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campo, valor }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'erro');
      toast.success(t('corrected'));
    } catch {
      setInsight((prev) =>
        prev ? ({ ...prev, [campo]: anterior } as InsightRow) : prev,
      );
      toast.error(t('correctFailed'));
    } finally {
      setSaving(null);
    }
  }

  if (!insight) return null;

  const meta = TEMPERATURA_META[insight.temperatura] ?? TEMPERATURA_META.indefinido;
  const Icon = meta.icon;
  const momentos = (insight.momentos ?? []).slice(-4).reverse();

  return (
    <div className="mb-4 rounded-xl border border-border bg-card-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          <Radar className="h-3 w-3 text-primary" /> {t('title')}
        </span>

        <div className="flex items-center gap-1">
          {/* Intenção — o QUE a pessoa quer (047). Clicável: corrigir
              ensina o Radar. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={saving !== null}
              title={t('changeIntent')}
              className="flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <span>{INTENCAO_EMOJI[insight.intencao] ?? '❓'}</span>
              {t(`intencao.${insight.intencao}`)}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="border-border bg-popover">
              {INTENCOES.map((op) => (
                <DropdownMenuItem
                  key={op}
                  onClick={() => void classify('intencao', op)}
                  className={cn(op === insight.intencao && 'text-primary')}
                >
                  <span className="mr-2">{INTENCAO_EMOJI[op]}</span>
                  {t(`intencao.${op}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={saving !== null}
              title={t('changeTemperature')}
              className={cn(
                'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize transition-opacity hover:opacity-80',
                meta.chip,
              )}
            >
              <Icon className="h-3 w-3" />
              {t(`temperatura.${insight.temperatura}`)}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="border-border bg-popover">
              {TEMPERATURAS.map((op) => (
                <DropdownMenuItem
                  key={op}
                  onClick={() => void classify('temperatura', op)}
                  className={cn(op === insight.temperatura && 'text-primary')}
                >
                  {t(`temperatura.${op}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {insight.interesse && (
        <p className="mt-2 text-sm font-medium leading-snug text-foreground">
          {insight.interesse}
        </p>
      )}
      {insight.resumo && (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {insight.resumo}
        </p>
      )}

      {insight.proximo_contato_em && (
        <div className="mt-2 flex items-start gap-1.5 rounded-md bg-primary-soft px-2 py-1.5 text-[11px] text-primary">
          <CalendarClock className="mt-px h-3 w-3 shrink-0" />
          <span>
            {t('nextContact', {
              date: formatMediumDateTime(insight.proximo_contato_em),
            })}
            {insight.proximo_contato_motivo
              ? ` — ${insight.proximo_contato_motivo}`
              : ''}
          </span>
        </div>
      )}

      {momentos.length > 0 && (
        <ul className="mt-2 space-y-1">
          {momentos.map((m, i) => (
            <li
              key={`${m.em}-${i}`}
              className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground"
            >
              <span className="shrink-0">{MOMENTO_ICON[m.tipo] ?? '•'}</span>
              <span>{m.texto}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Jornada completa aqui dentro (048): o atendente vê a história
          inteira do cliente — com datas — sem sair da conversa. */}
      <button
        type="button"
        onClick={() => void toggleJourney()}
        className="mt-2 flex w-full items-center justify-center gap-1 rounded-md py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <History className="h-3 w-3" />
        {journeyOpen ? t('hideJourney') : t('showJourney')}
        <ChevronDown
          className={cn('h-3 w-3 transition-transform', journeyOpen && 'rotate-180')}
        />
      </button>

      {journeyOpen && (
        <div className="mt-1 border-t border-border pt-2">
          {journey === null ? (
            <div className="flex justify-center py-3">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : journey.length === 0 ? (
            <p className="py-2 text-center text-[11px] text-muted-foreground">
              {t('noJourney')}
            </p>
          ) : (
            <ol className="space-y-2 border-l border-border pl-3">
              {journey.map((ev, i) => (
                <li key={`${ev.em}-${i}`} className="relative">
                  <span className="absolute -left-[1.15rem] top-0 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-card-2 text-[9px]">
                    {ev.icone}
                  </span>
                  <p className="text-[11px] leading-snug text-foreground">
                    {ev.texto}
                  </p>
                  {ev.detalhe && (
                    <p className="line-clamp-2 text-[10px] leading-snug text-muted-foreground">
                      {ev.detalhe}
                    </p>
                  )}
                  <p className="text-[9px] text-muted-foreground/70">
                    {formatMediumDate(ev.em)}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
