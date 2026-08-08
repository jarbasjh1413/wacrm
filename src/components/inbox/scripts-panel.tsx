'use client';

// Painel lateral de scripts e respostas por CATEGORIA (048) — réplica
// do painel direito da extensão que o Jarbas usa no WhatsApp Web
// (VENDAS → rapido, Catálogo, GARANTIA, SEQ1-4...).
//
// Duas famílias no mesmo painel, porque na cabeça de quem atende é a
// mesma coisa ("mandar aquele texto"):
//   • Respostas rápidas — um texto, vai direto;
//   • Scripts — a sequência inteira (vídeo + textos), um toque.
// Busca filtra as duas; um clique envia na conversa aberta.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Check,
  ChevronDown,
  Clapperboard,
  Loader2,
  Plus,
  Search,
  Send,
  X,
  Zap,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface PanelItem {
  id: string;
  kind: 'quick_reply' | 'script';
  title: string;
  preview: string;
  categoria: string;
}

interface ScriptsPanelProps {
  conversationId: string;
  onClose: () => void;
  /** Envia um texto simples na conversa (mesmo caminho do composer). */
  onSendText: (text: string) => Promise<void> | void;
}

/** Categoria dos itens sem categoria definida. */
const SEM_CATEGORIA = '__sem__';

export function ScriptsPanel({
  conversationId,
  onClose,
  onSendText,
}: ScriptsPanelProps) {
  const t = useTranslations('Inbox.scriptsPanel');
  const supabase = createClient();
  const [items, setItems] = useState<PanelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const { accountId } = useAuth();

  const fetchItems = useCallback(async () => {
    const [repliesRes, scriptsRes] = await Promise.all([
      supabase
        .from('quick_replies')
        .select('id, title, content_text, categoria')
        .order('title'),
      supabase
        .from('message_scripts')
        .select('id, name, description, categoria')
        .order('name'),
    ]);

    const merged: PanelItem[] = [
      ...((repliesRes.data ?? []) as Record<string, unknown>[]).map((r) => ({
        id: r.id as string,
        kind: 'quick_reply' as const,
        title: r.title as string,
        preview: ((r.content_text as string | null) ?? '').slice(0, 120),
        categoria: ((r.categoria as string | null) ?? SEM_CATEGORIA).trim(),
      })),
      ...((scriptsRes.data ?? []) as Record<string, unknown>[]).map((s) => ({
        id: s.id as string,
        kind: 'script' as const,
        title: s.name as string,
        preview: ((s.description as string | null) ?? '').slice(0, 120),
        categoria: ((s.categoria as string | null) ?? SEM_CATEGORIA).trim(),
      })),
    ];
    setItems(merged);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    // setState pós-await, padrão das demais telas.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchItems();
  }, [fetchItems]);

  // Criação rápida sem sair da conversa.
  const [creating, setCreating] = useState(false);
  const [savingNew, setSavingNew] = useState(false);
  const [form, setForm] = useState({ title: '', categoria: '', texto: '' });

  /** Categorias já em uso — vira autocomplete no campo. */
  const categoriasExistentes = useMemo(
    () =>
      [...new Set(items.map((i) => i.categoria))]
        .filter((c) => c && c !== SEM_CATEGORIA)
        .sort(),
    [items],
  );

  const saveQuickReply = useCallback(async () => {
    if (!form.title.trim() || !form.texto.trim()) {
      toast.error(t('newValidation'));
      return;
    }
    if (!accountId) return;
    setSavingNew(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const userId = session?.user?.id;
      if (!userId) throw new Error(t('sendFailed'));

      const { error } = await supabase.from('quick_replies').insert({
        account_id: accountId,
        user_id: userId,
        title: form.title.trim(),
        kind: 'text',
        content_text: form.texto.trim(),
        categoria: form.categoria.trim() || null,
      });
      if (error) throw new Error(error.message);
      toast.success(t('newSaved'));
      setCreating(false);
      setForm({ title: '', categoria: '', texto: '' });
      void fetchItems();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('sendFailed'));
    } finally {
      setSavingNew(false);
    }
  }, [form, accountId, supabase, t, fetchItems]);


  /** Agrupa por categoria, com os sem-categoria por último. */
  const grupos = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtrados = q
      ? items.filter(
          (i) =>
            i.title.toLowerCase().includes(q) ||
            i.preview.toLowerCase().includes(q) ||
            i.categoria.toLowerCase().includes(q),
        )
      : items;

    const mapa = new Map<string, PanelItem[]>();
    for (const item of filtrados) {
      const lista = mapa.get(item.categoria) ?? [];
      lista.push(item);
      mapa.set(item.categoria, lista);
    }
    return [...mapa.entries()].sort(([a], [b]) => {
      if (a === SEM_CATEGORIA) return 1;
      if (b === SEM_CATEGORIA) return -1;
      return a.localeCompare(b);
    });
  }, [items, search]);

  async function fire(item: PanelItem) {
    setSendingId(item.id);
    try {
      if (item.kind === 'script') {
        const res = await fetch(`/api/scripts/${item.id}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversation_id: conversationId }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
        toast.success(t('scriptSent', { n: payload.sentCount ?? 0 }));
      } else {
        if (!item.preview.trim()) {
          toast.error(t('emptyReply'));
          return;
        }
        await onSendText(item.preview);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('sendFailed'));
    } finally {
      setSendingId(null);
    }
  }

  return (
    <div className="flex h-full w-72 flex-col border-l border-border bg-card">
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Zap className="h-4 w-4 text-primary" /> {t('title')}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('close')}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-2 border-b border-border p-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="h-8 border-border bg-muted pl-8 text-xs text-foreground"
          />
        </div>

        {/* Criar sem sair da conversa (048): o atendente acabou de
            escrever uma resposta boa? Salva ali mesmo. Sequências com
            mídia continuam em Configurações → Scripts. */}
        {creating ? (
          <div className="space-y-1.5 rounded-md border border-border bg-muted/50 p-2">
            <Input
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder={t('newTitlePlaceholder')}
              className="h-7 border-border bg-card text-xs text-foreground"
            />
            <Input
              value={form.categoria}
              onChange={(e) =>
                setForm((f) => ({ ...f, categoria: e.target.value }))
              }
              placeholder={t('newCategoryPlaceholder')}
              list="scripts-panel-categorias"
              className="h-7 border-border bg-card text-xs text-foreground"
            />
            <datalist id="scripts-panel-categorias">
              {categoriasExistentes.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <Textarea
              value={form.texto}
              onChange={(e) => setForm((f) => ({ ...f, texto: e.target.value }))}
              rows={3}
              placeholder={t('newTextPlaceholder')}
              className="border-border bg-card text-xs text-foreground"
            />
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => void saveQuickReply()}
                disabled={savingNew}
                className="flex flex-1 items-center justify-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {savingNew ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Check className="h-3 w-3" />
                )}
                {t('save')}
              </button>
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
              >
                {t('cancel')}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => {
                setForm({ title: '', categoria: '', texto: '' });
                setCreating(true);
              }}
              className="flex flex-1 items-center justify-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              <Plus className="h-3 w-3" /> {t('newReply')}
            </button>
            <Link
              href="/settings?tab=scripts"
              title={t('manageScripts')}
              className="flex items-center justify-center rounded-md border border-dashed border-border px-2 py-1 text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              <Clapperboard className="h-3 w-3" />
            </Link>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : grupos.length === 0 ? (
          <div className="px-2 py-8 text-center">
            <p className="text-xs text-muted-foreground">{t('empty')}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t('emptyHint')}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {grupos.map(([categoria, lista]) => {
              const aberta = !collapsed.has(categoria);
              return (
                <div key={categoria}>
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev);
                        if (next.has(categoria)) next.delete(categoria);
                        else next.add(categoria);
                        return next;
                      })
                    }
                    className="flex w-full items-center gap-1 px-1 py-1 text-[10px] font-semibold uppercase tracking-wider text-primary"
                  >
                    <ChevronDown
                      className={cn(
                        'h-3 w-3 transition-transform',
                        !aberta && '-rotate-90',
                      )}
                    />
                    {categoria === SEM_CATEGORIA ? t('uncategorized') : categoria}
                    <span className="ml-auto text-muted-foreground">
                      {lista.length}
                    </span>
                  </button>

                  {aberta && (
                    <ul className="mt-0.5 space-y-0.5">
                      {lista.map((item) => (
                        <li key={`${item.kind}-${item.id}`}>
                          <button
                            type="button"
                            onClick={() => void fire(item)}
                            disabled={sendingId !== null}
                            title={item.preview}
                            className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted disabled:opacity-50"
                          >
                            <span className="shrink-0 text-muted-foreground">
                              {sendingId === item.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                              ) : item.kind === 'script' ? (
                                <Clapperboard className="h-3.5 w-3.5 text-primary" />
                              ) : (
                                <Zap className="h-3.5 w-3.5" />
                              )}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs text-foreground">
                                {item.title}
                              </span>
                              {item.preview && (
                                <span className="block truncate text-[10px] text-muted-foreground">
                                  {item.preview}
                                </span>
                              )}
                            </span>
                            <Send className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
