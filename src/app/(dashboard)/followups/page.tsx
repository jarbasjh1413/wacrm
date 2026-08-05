'use client';

// Fila de aprovação do agente de follow-up (FASE 5, §10). Mobile-first
// de verdade: o Jarbas aprova pelo celular — cards empilhados, botões
// grandes, textarea editável. Abaixo da fila, o log dos últimos
// follow-ups (inclusive os automáticos, auto_sent).

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Handshake,
  Loader2,
  Send,
  Sparkles,
  Trash2,
  Wrench,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { formatMediumDateTime } from '@/lib/app-locale';
import { cn } from '@/lib/utils';

interface SuggestionRow {
  id: string;
  conversation_id: string;
  cenario: string;
  mensagem_sugerida: string;
  justificativa_ia: string | null;
  mensagem_final: string | null;
  status: string;
  os_id: string | null;
  created_at: string;
  decided_at: string | null;
  contact:
    | { name: string | null; phone: string; avatar_url: string | null }
    | { name: string | null; phone: string; avatar_url: string | null }[]
    | null;
}

const CENARIO_STYLES: Record<string, string> = {
  equipamento_pronto: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  pos_venda: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
  orcamento_sem_resposta: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
  lead_frio: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400',
};

function one<T>(v: T | T[] | null): T | null {
  return v ? (Array.isArray(v) ? (v[0] ?? null) : v) : null;
}

export default function FollowupsPage() {
  const t = useTranslations('Followups');
  const supabase = createClient();
  const [pending, setPending] = useState<SuggestionRow[]>([]);
  const [log, setLog] = useState<SuggestionRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    const select =
      'id, conversation_id, cenario, mensagem_sugerida, justificativa_ia, mensagem_final, status, os_id, created_at, decided_at, contact:contacts(name, phone, avatar_url)';
    const [pendingRes, logRes] = await Promise.all([
      supabase
        .from('followup_suggestions')
        .select(select)
        .eq('status', 'pending')
        .order('created_at', { ascending: true }),
      supabase
        .from('followup_suggestions')
        .select(select)
        .neq('status', 'pending')
        .order('decided_at', { ascending: false })
        .limit(20),
    ]);
    if (pendingRes.error || logRes.error) {
      toast.error(t('loadFailed'));
    } else {
      setPending((pendingRes.data ?? []) as unknown as SuggestionRow[]);
      setLog((logRes.data ?? []) as unknown as SuggestionRow[]);
    }
    setLoading(false);
  }, [supabase, t]);

  useEffect(() => {
    // setStates acontecem pós-await (padrão das demais páginas).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchAll();
  }, [fetchAll]);

  async function decide(row: SuggestionRow, action: 'approve' | 'discard') {
    setActingId(row.id);
    try {
      const res = await fetch(`/api/followups/${row.id}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          mensagem_final: drafts[row.id] ?? row.mensagem_sugerida,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
      toast.success(action === 'approve' ? t('sentToast') : t('discardedToast'));
      void fetchAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('actionFailed'));
    } finally {
      setActingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
          <Handshake className="h-6 w-6 text-primary" /> {t('title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {/* Fila de aprovação */}
          {pending.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card py-12 text-center">
              <Sparkles className="h-8 w-8 text-muted-foreground opacity-40" />
              <p className="text-sm text-muted-foreground">{t('emptyQueue')}</p>
              <p className="px-6 text-xs text-muted-foreground">{t('emptyQueueHint')}</p>
            </div>
          ) : (
            <div className="space-y-4">
              {pending.map((row) => {
                const contact = one(row.contact);
                const name = contact?.name || contact?.phone || '—';
                return (
                  <div
                    key={row.id}
                    className="space-y-3 rounded-xl border border-border bg-card p-4"
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-sm font-medium text-foreground">
                        {contact?.avatar_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={contact.avatar_url}
                            alt={name}
                            className="h-10 w-10 object-cover"
                          />
                        ) : (
                          name.charAt(0).toUpperCase()
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/inbox?c=${row.conversation_id}`}
                          className="block truncate text-sm font-semibold text-foreground hover:text-primary"
                        >
                          {name}
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          {row.os_id ? `OS ${row.os_id} · ` : ''}
                          {formatMediumDateTime(row.created_at)}
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className={cn(
                          'shrink-0 text-[10px]',
                          CENARIO_STYLES[row.cenario] ?? 'text-muted-foreground',
                        )}
                      >
                        {t(`cenarios.${row.cenario}`)}
                      </Badge>
                    </div>

                    {row.justificativa_ia && (
                      <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                        🤖 {row.justificativa_ia}
                      </p>
                    )}

                    <Textarea
                      value={drafts[row.id] ?? row.mensagem_sugerida}
                      onChange={(e) =>
                        setDrafts((d) => ({ ...d, [row.id]: e.target.value }))
                      }
                      rows={3}
                      className="bg-muted border-border text-sm text-foreground"
                    />

                    <div className="flex gap-2">
                      <Button
                        onClick={() => void decide(row, 'approve')}
                        disabled={actingId !== null}
                        className="h-11 flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
                      >
                        {actingId === row.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Send className="h-4 w-4" />
                        )}
                        {t('approveSend')}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => void decide(row, 'discard')}
                        disabled={actingId !== null}
                        className="h-11 border-border text-muted-foreground hover:bg-muted hover:text-red-400"
                      >
                        <Trash2 className="h-4 w-4" />
                        {t('discard')}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Log dos últimos follow-ups (inclui os automáticos) */}
          {log.length > 0 && (
            <div>
              <h2 className="mb-2 flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <Wrench className="h-3 w-3" /> {t('logTitle')}
              </h2>
              <ul className="divide-y divide-border rounded-xl border border-border bg-card">
                {log.map((row) => {
                  const contact = one(row.contact);
                  return (
                    <li key={row.id} className="space-y-1 px-4 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {contact?.name || contact?.phone || '—'}
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          <Badge
                            variant="outline"
                            className={cn(
                              'text-[10px]',
                              CENARIO_STYLES[row.cenario] ?? '',
                            )}
                          >
                            {t(`cenarios.${row.cenario}`)}
                          </Badge>
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">
                            {t(`status.${row.status}`)}
                          </Badge>
                        </span>
                      </div>
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {row.mensagem_final || row.mensagem_sugerida}
                      </p>
                      {row.decided_at && (
                        <p className="text-[10px] text-muted-foreground/70">
                          {formatMediumDateTime(row.decided_at)}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
