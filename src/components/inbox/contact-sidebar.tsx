"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import type { Contact, Deal, ContactNote, Tag } from "@/types";
import {
  Phone,
  Mail,
  Copy,
  Check,
  User,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
  Wrench,
  ClipboardList,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatMediumDate, formatMediumDateTime } from "@/lib/app-locale";
import { RadarCard } from "./radar-card";
import { useTranslations } from "next-intl";

/** Estado atual de uma OS na lateral — evento mais recente por os_id (043). */
interface OsOrderRow {
  os_id: string;
  evento: string;
  status: string | null;
  equipamento: string | null;
  valor_orcamento: number | null;
  unidade: string | null;
  data_evento: string;
}

/** Cores por status de OS (vocabulário do sistema de OS; fallback neutro). */
const OS_STATUS_STYLES: Record<string, string> = {
  pronto: "bg-emerald-500/15 text-emerald-400",
  orcamento_enviado: "bg-blue-500/15 text-blue-400",
  aguardando_aprovacao: "bg-amber-500/15 text-amber-400",
  entregue: "bg-slate-500/15 text-muted-foreground",
};

/** Campo da ficha do cliente — `source` marca o que veio da IA (048). */
interface ContactFieldRow {
  id: string;
  name: string;
  value: string;
  source: string;
}

interface ContactSidebarProps {
  contact: Contact | null;
  /** Conversa aberta — alimenta o card do Radar (§10.5). */
  conversationId?: string | null;
}

export function ContactSidebar({ contact, conversationId }: ContactSidebarProps) {
  const tSidebar = useTranslations("Inbox.sidebar");
  const tThread = useTranslations("Inbox.messageThread");

  const { accountId } = useAuth();
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [osOrders, setOsOrders] = useState<OsOrderRow[]>([]);
  const [fields, setFields] = useState<ContactFieldRow[]>([]);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    // Fetch deals, notes, tags and OS events in parallel
    const [dealsRes, notesRes, tagsRes, osRes, fieldsRes] = await Promise.all([
      supabase
        .from("deals")
        .select("*, stage:pipeline_stages(*)")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_notes")
        .select("*")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_tags")
        .select("id, tag_id, tags(*)")
        .eq("contact_id", contact.id),
      supabase
        .from("os_events")
        .select("os_id, evento, status, equipamento, valor_orcamento, unidade, data_evento")
        .eq("contact_id", contact.id)
        .order("data_evento", { ascending: false })
        .limit(50),
      // Ficha do cliente: valores + o nome do campo (048).
      supabase
        .from("contact_custom_values")
        .select("id, value, source, field:custom_fields(field_name)")
        .eq("contact_id", contact.id),
    ]);

    if (dealsRes.data) setDeals(dealsRes.data);
    if (notesRes.data) setNotes(notesRes.data);
    if (osRes.data) {
      // Uma linha por EVENTO no banco; a lateral mostra o estado atual de
      // cada OS = evento mais recente por os_id (lista já vem ordenada).
      const latestByOs = new Map<string, OsOrderRow>();
      for (const ev of osRes.data as OsOrderRow[]) {
        if (!latestByOs.has(ev.os_id)) latestByOs.set(ev.os_id, ev);
      }
      setOsOrders([...latestByOs.values()]);
    }
    if (fieldsRes.data) {
      setFields(
        (fieldsRes.data as Record<string, unknown>[])
          .map((row) => {
            const fieldRaw = row.field;
            const field = Array.isArray(fieldRaw) ? fieldRaw[0] : fieldRaw;
            const name = (field as { field_name?: string })?.field_name;
            const value = row.value as string | null;
            if (!name || !value?.trim()) return null;
            return {
              id: row.id as string,
              name,
              value: value.trim(),
              source: (row.source as string) ?? "human",
            };
          })
          .filter((f): f is ContactFieldRow => f !== null)
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
    }
    if (tagsRes.data) {
      const mapped = tagsRes.data
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ({
          ...(ct.tags as Tag),
          contact_tag_id: ct.id as string,
        }));
      setTags(mapped);
    }
  }, [contact]);

  // Load on contact change. setContactData/setTags run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContactData();
  }, [fetchContactData]);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    if (!accountId) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        contact_id: contact.id,
        account_id: accountId,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote("");
    }
    setAddingNote(false);
  }, [contact, newNote, accountId]);

  if (!contact) {
    return (
      <div className="flex h-full w-70 items-center justify-center border-l border-border bg-card">
        <p className="text-sm text-muted-foreground">{tThread("selectConversation")}</p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex h-full w-70 flex-col border-l border-border bg-card">
      {/* `min-h-0` é obrigatório: um filho de coluna flex nasce com
          min-height:auto e cresce ALÉM do container em vez de rolar —
          era por isso que a lateral cortava os últimos campos (ficha,
          OSs, notas) sem barra de rolagem. */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4">
          {/* Radar de Leads — o resumo que a IA montou desta conversa.
              Fica no topo: é o que responde "quem é esse cliente e em
              que pé está?" antes de qualquer outra coisa. */}
          {conversationId && <RadarCard conversationId={conversationId} />}

          {/* Contact Info */}
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-foreground">
              {contact.avatar_url ? (
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            <h3 className="mt-3 text-sm font-semibold text-foreground">
              {displayName}
            </h3>
            {contact.company && (
              <p className="text-xs text-muted-foreground">{contact.company}</p>
            )}
          </div>

          {/* Phone */}
          <div className="mt-4 space-y-2">
            <button
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 text-left">{contact.phone}</span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>

            {contact.email && (
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Ficha do cliente — o que a IA foi deduzindo da conversa
              (cidade, profissão, equipamento) mais o que a equipe
              preencheu à mão. Some quando não há nada ainda. */}
          {fields.length > 0 && (
            <>
              <div>
                <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  <ClipboardList className="h-3 w-3" />
                  {tSidebar("profile")}
                </div>
                <dl className="mt-2 space-y-1">
                  {fields.map((f) => (
                    <div
                      key={f.id}
                      className="flex items-baseline justify-between gap-2 rounded-md px-1 py-0.5"
                    >
                      <dt className="shrink-0 text-[11px] text-muted-foreground">
                        {f.name}
                      </dt>
                      <dd className="flex min-w-0 items-center gap-1 text-xs text-foreground">
                        <span className="truncate">{f.value}</span>
                        {f.source === "ai" && (
                          <span title={tSidebar("filledByAi")}>
                            <Sparkles className="h-2.5 w-2.5 shrink-0 text-primary" />
                          </span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>

              <div className="my-4 border-t border-border" />
            </>
          )}

          {/* Tags */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <TagIcon className="h-3 w-3" />
              {tSidebar("tags")}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {tags.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noTags")}</p>
              ) : (
                tags.map((tag) => (
                  <span
                    key={tag.contact_tag_id}
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                    }}
                  >
                    {tag.name}
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Active Deals */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <DollarSign className="h-3 w-3" />
              {tSidebar("deals")}
            </div>
            <div className="mt-2 space-y-2">
              {deals.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noDeals")}</p>
              ) : (
                deals.map((deal) => (
                  <div
                    key={deal.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="text-sm font-medium text-foreground">
                      {deal.title}
                    </p>
                    <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {deal.currency ?? "$"}
                        {deal.value.toLocaleString()}
                      </span>
                      {deal.stage && (
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[10px]"
                          style={{
                            backgroundColor: `${deal.stage.color}20`,
                            color: deal.stage.color,
                          }}
                        >
                          {deal.stage.name}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Ordens de serviço (eventos do sistema de OS — Fase 4) */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <Wrench className="h-3 w-3" />
              {tSidebar("osOrders")}
            </div>
            <div className="mt-2 space-y-2">
              {osOrders.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">
                  {tSidebar("noOsOrders")}
                </p>
              ) : (
                osOrders.map((order) => (
                  <div key={order.os_id} className="rounded-lg bg-muted px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium text-foreground">
                        {order.equipamento ||
                          tSidebar("osNumber", { id: order.os_id })}
                      </p>
                      {order.status && (
                        <span
                          className={cn(
                            "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] capitalize",
                            OS_STATUS_STYLES[order.status] ??
                              "bg-muted-foreground/10 text-muted-foreground",
                          )}
                        >
                          {order.status.replaceAll("_", " ")}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {tSidebar("osNumber", { id: order.os_id })}
                        {order.unidade ? ` · ${order.unidade}` : ""}
                      </span>
                      <span>
                        {order.valor_orcamento != null
                          ? `R$ ${order.valor_orcamento.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
                          : formatMediumDate(order.data_evento)}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Notes */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <StickyNote className="h-3 w-3" />
              {tSidebar("notes")}
            </div>
            <div className="mt-2">
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder={tSidebar("addNotePlaceholder")}
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <Button
                  size="sm"
                  className="h-auto bg-primary px-2 hover:bg-primary/90"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div
                    key={note.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {note.note_text}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {formatMediumDateTime(note.created_at)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
