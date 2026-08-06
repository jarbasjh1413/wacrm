'use client';

// Encaminhar mensagem (réplica WhatsApp Web): escolhe um contato e o
// conteúdo (texto ou mídia) sai pela conversa dele — o servidor
// find-or-creates a conversa via contact_id (mesma rota do inbox).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Search, Share } from 'lucide-react';
import type { Contact, Message } from '@/types';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface ForwardDialogProps {
  message: Message | null;
  onOpenChange: (open: boolean) => void;
}

const MEDIA_KINDS = new Set(['image', 'video', 'audio', 'document']);

export function ForwardDialog({ message, onOpenChange }: ForwardDialogProps) {
  const t = useTranslations('Inbox.forward');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [sendingTo, setSendingTo] = useState<string | null>(null);

  const open = message !== null;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from('contacts')
        .select('id, name, phone, avatar_url')
        .order('name')
        .limit(200);
      if (!cancelled) {
        setContacts((data ?? []) as Contact[]);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (c) =>
        (c.name ?? '').toLowerCase().includes(q) || c.phone.includes(q),
    );
  }, [contacts, search]);

  const forwardTo = useCallback(
    async (contact: Contact) => {
      if (!message) return;
      setSendingTo(contact.id);
      try {
        const isMedia = MEDIA_KINDS.has(message.content_type);
        const body: Record<string, unknown> = {
          contact_id: contact.id,
          message_type: isMedia ? message.content_type : 'text',
        };
        if (isMedia) {
          body.media_url = message.media_url;
          if (message.content_text) body.content_text = message.content_text;
        } else {
          body.content_text = message.content_text ?? '';
        }
        const res = await fetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
        toast.success(t('sent', { name: contact.name || contact.phone }));
        onOpenChange(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('failed'));
      } finally {
        setSendingTo(null);
      }
    },
    [message, onOpenChange, t],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <Share className="h-4 w-4 text-primary" /> {t('title')}
          </DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="border-border bg-muted pl-9 text-sm text-foreground"
          />
        </div>

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <ul className="max-h-72 space-y-0.5 overflow-y-auto">
            {filtered.map((contact) => {
              const name = contact.name || contact.phone;
              return (
                <li key={contact.id}>
                  <button
                    type="button"
                    disabled={sendingTo !== null}
                    onClick={() => void forwardTo(contact)}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-sm font-medium text-foreground">
                      {contact.avatar_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={contact.avatar_url}
                          alt={name}
                          className="h-9 w-9 object-cover"
                        />
                      ) : (
                        name.charAt(0).toUpperCase()
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">
                        {name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {contact.phone}
                      </span>
                    </span>
                    {sendingTo === contact.id && (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                    )}
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 && (
              <li className="py-6 text-center text-sm text-muted-foreground">
                {t('noResults')}
              </li>
            )}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
