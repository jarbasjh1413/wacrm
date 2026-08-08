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
  Flame,
  Radar,
  Snowflake,
  Sun,
  HelpCircle,
} from 'lucide-react';
import { formatMediumDateTime } from '@/lib/app-locale';
import { cn } from '@/lib/utils';

type Temperatura = 'quente' | 'morno' | 'frio' | 'indefinido';

interface Momento {
  em: string;
  tipo: string;
  texto: string;
}

interface InsightRow {
  temperatura: Temperatura;
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

  const fetchInsight = useCallback(async () => {
    const { data } = await supabase
      .from('conversation_insights')
      .select(
        'temperatura, interesse, resumo, momentos, proximo_contato_em, proximo_contato_motivo, ultima_analise_em',
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
        <span
          className={cn(
            'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize',
            meta.chip,
          )}
        >
          <Icon className="h-3 w-3" />
          {t(`temperatura.${insight.temperatura}`)}
        </span>
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
    </div>
  );
}
