'use client';

// Página de mensagens agendadas (FASE 3, §8): tudo que foi marcado para
// sair depois — texto avulso ou script — com opção de cancelar antes do
// horário. O envio em si é da fila do servidor (scheduled-queue.ts).

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CalendarClock, Clapperboard, Loader2, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatMediumDateTime } from '@/lib/app-locale';
import { cn } from '@/lib/utils';

interface ScheduledRow {
  id: string;
  content_text: string | null;
  send_at: string;
  status: 'scheduled' | 'sent' | 'canceled' | 'failed';
  error_message: string | null;
  conversation_id: string;
  script: { name: string } | { name: string }[] | null;
  conversation:
    | {
        contact:
          | { name: string | null; phone: string }
          | { name: string | null; phone: string }[]
          | null;
      }
    | {
        contact:
          | { name: string | null; phone: string }
          | { name: string | null; phone: string }[]
          | null;
      }[]
    | null;
}

const STATUS_STYLES: Record<ScheduledRow['status'], string> = {
  scheduled: 'border-primary/30 bg-primary/10 text-primary',
  sent: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  canceled: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
  failed: 'border-red-500/30 bg-red-500/10 text-red-400',
};

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export default function ScheduledMessagesPage() {
  const t = useTranslations('Scheduled');
  const supabase = createClient();
  const [rows, setRows] = useState<ScheduledRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancelingId, setCancelingId] = useState<string | null>(null);

  // `loading` já nasce true — refetches (após cancelar) atualizam a
  // lista silenciosamente, sem flash de spinner.
  const fetchRows = useCallback(async () => {
    const { data, error } = await supabase
      .from('scheduled_messages')
      .select(
        'id, content_text, send_at, status, error_message, conversation_id, script:message_scripts(name), conversation:conversations(contact:contacts(name, phone))',
      )
      .order('send_at', { ascending: false })
      .limit(100);
    if (error) {
      toast.error(t('loadFailed'));
    } else {
      setRows((data ?? []) as unknown as ScheduledRow[]);
    }
    setLoading(false);
  }, [supabase, t]);

  useEffect(() => {
    // Todos os setState de fetchRows acontecem após o await (padrão das
    // demais páginas — ver contacts/page.tsx).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchRows();
  }, [fetchRows]);

  async function handleCancel(id: string) {
    setCancelingId(id);
    // Condicionado ao status ainda ser 'scheduled' — se a fila enviou
    // no meio tempo, nada muda e a UI recarrega mostrando 'sent'.
    const { error } = await supabase
      .from('scheduled_messages')
      .update({ status: 'canceled' })
      .eq('id', id)
      .eq('status', 'scheduled');
    setCancelingId(null);
    if (error) {
      toast.error(t('cancelFailed'));
      return;
    }
    toast.success(t('canceled'));
    void fetchRows();
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
          <CalendarClock className="h-6 w-6 text-primary" /> {t('title')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card py-16 text-center">
          <CalendarClock className="h-8 w-8 text-muted-foreground opacity-40" />
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
          <p className="text-xs text-muted-foreground">{t('emptyHint')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead>{t('table.contact')}</TableHead>
                <TableHead>{t('table.content')}</TableHead>
                <TableHead>{t('table.when')}</TableHead>
                <TableHead>{t('table.status')}</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const contact = one(one(row.conversation)?.contact ?? null);
                const script = one(row.script);
                return (
                  <TableRow key={row.id} className="border-border">
                    <TableCell className="font-medium text-foreground">
                      <Link
                        href={`/inbox?c=${row.conversation_id}`}
                        className="hover:text-primary"
                      >
                        {contact?.name || contact?.phone || '—'}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-72 text-muted-foreground">
                      {script ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Clapperboard className="h-3.5 w-3.5 text-primary" />
                          {t('scriptContent', { name: script.name })}
                        </span>
                      ) : (
                        <span className="block truncate">{row.content_text}</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatMediumDateTime(row.send_at)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={cn('text-[10px]', STATUS_STYLES[row.status])}
                        title={row.error_message ?? undefined}
                      >
                        {t(`status.${row.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {row.status === 'scheduled' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleCancel(row.id)}
                          disabled={cancelingId === row.id}
                          className="h-8 text-muted-foreground hover:text-red-400"
                        >
                          {cancelingId === row.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <XCircle className="h-4 w-4" />
                          )}
                          {t('cancel')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
