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
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatMediumDateTime } from '@/lib/app-locale';
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
    </div>
  );
}
