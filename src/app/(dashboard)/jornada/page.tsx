'use client';

// Jornada (FASE 6, §10.5) — a memória do CRM que o Jarbas pediu:
// "poder ver há um ano atrás o que foi conversado com o cliente".
//
// Duas leituras na mesma tela:
//   1. FUNIL do período — quantos leads em cada temperatura/intenção,
//      para bater o olho na saúde da operação;
//   2. LINHA DO TEMPO de um lead — momentos que a IA capturou, ordens
//      de serviço e follow-ups enviados, tudo em ordem cronológica.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { useTranslations } from 'next-intl';
import {
  CalendarClock,
  Flame,
  Handshake,
  Loader2,
  MessageSquare,
  Route,
  Search,
  Snowflake,
  Sun,
  Wrench,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { formatMediumDate, formatMediumDateTime } from '@/lib/app-locale';
import { cn } from '@/lib/utils';

type Temperatura = 'quente' | 'morno' | 'frio' | 'indefinido';

interface LeadRow {
  conversation_id: string;
  contact_id: string | null;
  temperatura: Temperatura;
  intencao: string;
  interesse: string | null;
  resumo: string | null;
  momentos: { em: string; tipo: string; texto: string }[] | null;
  proximo_contato_em: string | null;
  ultima_analise_em: string | null;
  contact: { name: string | null; phone: string; avatar_url: string | null } | null;
}

/** Um ponto na linha do tempo, venha de onde vier. */
interface TimelineEvent {
  em: string;
  fonte: 'momento' | 'os' | 'followup';
  icone: string;
  texto: string;
  detalhe?: string;
}

const TEMPERATURA_META: Record<Temperatura, { icon: typeof Flame; cls: string }> = {
  quente: { icon: Flame, cls: 'border-red-500/30 bg-red-500/10 text-red-400' },
  morno: { icon: Sun, cls: 'border-amber-500/30 bg-amber-500/10 text-amber-400' },
  frio: { icon: Snowflake, cls: 'border-sky-500/30 bg-sky-500/10 text-sky-400' },
  indefinido: {
    icon: MessageSquare,
    cls: 'border-border bg-muted text-muted-foreground',
  },
};

const MOMENTO_ICON: Record<string, string> = {
  promessa_data: '📅',
  objecao: '⚠️',
  orcamento: '💰',
  interesse: '🎯',
  pessoal: '👤',
};

const INTENCAO_EMOJI: Record<string, string> = {
  compra: '🛒',
  assistencia: '🔧',
  orcamento: '🧾',
  informacao: 'ℹ️',
  pos_venda: '🤝',
  outro: '💬',
  indefinido: '❓',
};

export default function JornadaPage() {
  const t = useTranslations('Jornada');
  const supabase = createClient();
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<LeadRow | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[] | null>(null);

  const fetchLeads = useCallback(async () => {
    const { data } = await supabase
      .from('conversation_insights')
      .select(
        'conversation_id, contact_id, temperatura, intencao, interesse, resumo, momentos, proximo_contato_em, ultima_analise_em, contact:contacts(name, phone, avatar_url)',
      )
      .order('ultima_analise_em', { ascending: false })
      .limit(200);
    setLeads((data ?? []) as unknown as LeadRow[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    // setState pós-await, padrão das demais telas.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchLeads();
  }, [fetchLeads]);

  /** Funil do período: quantos leads em cada temperatura. */
  const funil = useMemo(() => {
    const counts: Record<Temperatura, number> = {
      quente: 0,
      morno: 0,
      frio: 0,
      indefinido: 0,
    };
    for (const lead of leads) counts[lead.temperatura] = (counts[lead.temperatura] ?? 0) + 1;
    return counts;
  }, [leads]);

  /** Quebra por tipo de atendimento — cada um tem caminho diferente. */
  const porIntencao = useMemo(() => {
    const counts = new Map<string, number>();
    for (const lead of leads) {
      if (lead.intencao === 'indefinido') continue;
      counts.set(lead.intencao, (counts.get(lead.intencao) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [leads]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return leads;
    return leads.filter((l) => {
      const nome = (l.contact?.name ?? '').toLowerCase();
      const fone = l.contact?.phone ?? '';
      const interesse = (l.interesse ?? '').toLowerCase();
      return nome.includes(q) || fone.includes(q) || interesse.includes(q);
    });
  }, [leads, search]);

  /**
   * Monta a linha do tempo do lead reunindo TODAS as fontes: os
   * momentos que a IA capturou, as ordens de serviço e os follow-ups
   * que saíram. É o "há um ano, o que foi conversado".
   */
  const openTimeline = useCallback(
    async (lead: LeadRow) => {
      setSelected(lead);
      setTimeline(null);

      const [osRes, followRes] = await Promise.all([
        lead.contact_id
          ? supabase
              .from('os_events')
              .select('os_id, evento, status, equipamento, valor_orcamento, data_evento')
              .eq('contact_id', lead.contact_id)
              .order('data_evento', { ascending: false })
              .limit(50)
          : Promise.resolve({ data: [] }),
        supabase
          .from('followup_suggestions')
          .select('cenario, status, mensagem_final, mensagem_sugerida, decided_at, created_at')
          .eq('conversation_id', lead.conversation_id)
          .in('status', ['sent', 'edited', 'auto_sent'])
          .order('created_at', { ascending: false })
          .limit(50),
      ]);

      const events: TimelineEvent[] = [
        ...(lead.momentos ?? []).map((m) => ({
          em: m.em,
          fonte: 'momento' as const,
          icone: MOMENTO_ICON[m.tipo] ?? '•',
          texto: m.texto,
        })),
        ...((osRes.data ?? []) as Record<string, unknown>[]).map((o) => ({
          em: o.data_evento as string,
          fonte: 'os' as const,
          icone: '🔧',
          texto: `OS ${o.os_id}${o.status ? ` — ${String(o.status).replaceAll('_', ' ')}` : ''}`,
          detalhe: [
            o.equipamento as string | null,
            o.valor_orcamento != null ? `R$ ${o.valor_orcamento}` : null,
          ]
            .filter(Boolean)
            .join(' · '),
        })),
        ...((followRes.data ?? []) as Record<string, unknown>[]).map((f) => ({
          em: (f.decided_at as string) ?? (f.created_at as string),
          fonte: 'followup' as const,
          icone: '🤖',
          texto: t(`cenarios.${f.cenario}`),
          detalhe: ((f.mensagem_final ?? f.mensagem_sugerida) as string) ?? undefined,
        })),
      ].sort((a, b) => (a.em > b.em ? -1 : 1));

      setTimeline(events);
    },
    [supabase, t],
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
          <Route className="h-6 w-6 text-primary" /> {t('title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : leads.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card py-16 text-center">
          <Route className="h-8 w-8 text-muted-foreground opacity-40" />
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
          <p className="px-6 text-xs text-muted-foreground">{t('emptyHint')}</p>
        </div>
      ) : (
        <>
          {/* Funil do período */}
          <div className="grid gap-3 sm:grid-cols-4">
            {(['quente', 'morno', 'frio', 'indefinido'] as Temperatura[]).map((temp) => {
              const meta = TEMPERATURA_META[temp];
              const Icon = meta.icon;
              return (
                <div
                  key={temp}
                  className={cn('rounded-xl border p-4', meta.cls)}
                >
                  <div className="flex items-center gap-1.5 text-xs font-medium">
                    <Icon className="h-3.5 w-3.5" />
                    {t(`temperatura.${temp}`)}
                  </div>
                  <p className="mt-1 text-2xl font-bold tabular-nums">
                    {funil[temp]}
                  </p>
                </div>
              );
            })}
          </div>

          {porIntencao.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {porIntencao.map(([intencao, count]) => (
                <span
                  key={intencao}
                  className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground"
                >
                  <span>{INTENCAO_EMOJI[intencao] ?? '❓'}</span>
                  {t(`intencao.${intencao}`)}
                  <span className="font-semibold tabular-nums text-foreground">
                    {count}
                  </span>
                </span>
              ))}
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:items-start">
            {/* Lista de leads */}
            <div className="space-y-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('searchPlaceholder')}
                  className="border-border bg-muted pl-9 text-sm text-foreground"
                />
              </div>

              <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                {filtered.map((lead) => {
                  const nome = lead.contact?.name || lead.contact?.phone || '—';
                  const meta = TEMPERATURA_META[lead.temperatura];
                  const Icon = meta.icon;
                  const active = selected?.conversation_id === lead.conversation_id;
                  return (
                    <li key={lead.conversation_id}>
                      <button
                        type="button"
                        onClick={() => void openTimeline(lead)}
                        className={cn(
                          'flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50',
                          active && 'bg-muted/70',
                        )}
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-sm font-medium text-foreground">
                          {lead.contact?.avatar_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={lead.contact.avatar_url}
                              alt={nome}
                              className="h-9 w-9 object-cover"
                            />
                          ) : (
                            nome.charAt(0).toUpperCase()
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium text-foreground">
                              {nome}
                            </span>
                            <span className="shrink-0 text-xs">
                              {INTENCAO_EMOJI[lead.intencao] ?? ''}
                            </span>
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {lead.interesse || lead.resumo || t('noSummary')}
                          </span>
                        </span>
                        <span
                          className={cn(
                            'flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px]',
                            meta.cls,
                          )}
                        >
                          <Icon className="h-3 w-3" />
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            {/* Linha do tempo do lead escolhido */}
            <div className="rounded-xl border border-border bg-card p-4">
              {!selected ? (
                <div className="flex flex-col items-center gap-2 py-16 text-center">
                  <CalendarClock className="h-7 w-7 text-muted-foreground opacity-40" />
                  <p className="text-sm text-muted-foreground">{t('pickLead')}</p>
                </div>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-semibold text-foreground">
                        {selected.contact?.name || selected.contact?.phone}
                      </h2>
                      {selected.interesse && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {selected.interesse}
                        </p>
                      )}
                    </div>
                    <Link
                      href={`/inbox?c=${selected.conversation_id}`}
                      className="flex shrink-0 items-center gap-1 rounded-md bg-primary-soft px-2 py-1 text-xs text-primary hover:bg-primary-soft-2"
                    >
                      <MessageSquare className="h-3 w-3" /> {t('openChat')}
                    </Link>
                  </div>

                  {selected.proximo_contato_em && (
                    <p className="mt-2 flex items-center gap-1.5 rounded-md bg-primary-soft px-2 py-1.5 text-[11px] text-primary">
                      <CalendarClock className="h-3 w-3" />
                      {t('nextContact', {
                        date: formatMediumDateTime(selected.proximo_contato_em),
                      })}
                    </p>
                  )}

                  {timeline === null ? (
                    <div className="flex justify-center py-10">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : timeline.length === 0 ? (
                    <p className="py-10 text-center text-sm text-muted-foreground">
                      {t('noEvents')}
                    </p>
                  ) : (
                    <ol className="mt-4 space-y-3 border-l border-border pl-4">
                      {timeline.map((ev, i) => (
                        <li key={`${ev.em}-${i}`} className="relative">
                          <span className="absolute -left-[1.4rem] top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-card text-[10px]">
                            {ev.icone}
                          </span>
                          <p className="text-xs text-foreground">{ev.texto}</p>
                          {ev.detalhe && (
                            <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                              {ev.detalhe}
                            </p>
                          )}
                          <p className="mt-0.5 text-[10px] text-muted-foreground/70">
                            {formatMediumDate(ev.em)}
                            {ev.fonte === 'followup' && (
                              <span className="ml-1 inline-flex items-center gap-0.5">
                                <Handshake className="h-2.5 w-2.5" />
                              </span>
                            )}
                            {ev.fonte === 'os' && (
                              <span className="ml-1 inline-flex items-center gap-0.5">
                                <Wrench className="h-2.5 w-2.5" />
                              </span>
                            )}
                          </p>
                        </li>
                      ))}
                    </ol>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
