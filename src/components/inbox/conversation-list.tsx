"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  matchesContactFilters,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus, Tag } from "@/types";
import {
  Search,
  ChevronDown,
  X,
  Check,
  ListChecks,
  MailPlus,
  Archive,
  ArchiveRestore,
  Trash2,
  Pin,
  PinOff,
} from "lucide-react";
import { toast } from "sonner";
import { formatWhatsAppTime } from "@/lib/app-locale";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};



type InboxFilter = ConversationStatus | "all" | "unread";

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
}: ConversationListProps) {
  const t = useTranslations("Inbox.conversationList");
  
  const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(() => [
    { label: t("filterAll"), value: "all" },
    { label: t("filterUnread"), value: "unread" },
    { label: t("filterOpen"), value: "open" },
    { label: t("filterPending"), value: "pending" },
    { label: t("filterClosed"), value: "closed" },
  ], [t]);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [loading, setLoading] = useState(true);

  // Seleção múltipla + ações de conversa (réplica WhatsApp Web).
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteTargets, setDeleteTargets] = useState<string[] | null>(null);
  const [acting, setActing] = useState(false);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  /** Aplica patch no banco + atualização otimista na lista do pai. */
  const applyConversationPatch = useCallback(
    async (
      ids: string[],
      patch: Partial<Pick<Conversation, "status" | "unread_count" | "pinned_at">>,
      successMsg: string,
    ) => {
      if (ids.length === 0) return;
      setActing(true);
      const supabase = createClient();
      const { error } = await supabase
        .from("conversations")
        .update(patch)
        .in("id", ids);
      setActing(false);
      if (error) {
        toast.error(t("actionFailed"));
        return;
      }
      onConversationsLoaded(
        conversations.map((c) =>
          ids.includes(c.id) ? { ...c, ...patch } : c,
        ),
      );
      toast.success(successMsg);
      exitSelectMode();
    },
    [conversations, exitSelectMode, onConversationsLoaded, t],
  );

  const deleteConversations = useCallback(
    async (ids: string[]) => {
      setActing(true);
      const supabase = createClient();
      const { error } = await supabase
        .from("conversations")
        .delete()
        .in("id", ids);
      setActing(false);
      setDeleteTargets(null);
      if (error) {
        toast.error(t("actionFailed"));
        return;
      }
      onConversationsLoaded(
        conversations.filter((c) => !ids.includes(c.id)),
      );
      toast.success(t("bulkDeleted", { n: ids.length }));
      exitSelectMode();
    },
    [conversations, exitSelectMode, onConversationsLoaded, t],
  );

  const handleRowAction = useCallback(
    (action: ConversationAction, conv: Conversation) => {
      switch (action) {
        case "pin":
          void applyConversationPatch(
            [conv.id],
            { pinned_at: new Date().toISOString() },
            t("pinned"),
          );
          break;
        case "unpin":
          void applyConversationPatch([conv.id], { pinned_at: null }, t("unpinned"));
          break;
        case "mark_unread":
          void applyConversationPatch([conv.id], { unread_count: 1 }, t("markedUnread"));
          break;
        case "mark_read":
          void applyConversationPatch([conv.id], { unread_count: 0 }, t("markedRead"));
          break;
        case "close":
          void applyConversationPatch([conv.id], { status: "closed" }, t("bulkClosed", { n: 1 }));
          break;
        case "reopen":
          void applyConversationPatch([conv.id], { status: "open" }, t("bulkReopened", { n: 1 }));
          break;
        case "delete":
          setDeleteTargets([conv.id]);
          break;
      }
    },
    [applyConversationPatch, t],
  );
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .order("last_message_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(normalizeConversations(data ?? []));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken]);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("tags").select("*").order("name");
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  /**
   * Chips de funil (migration 046) — a etiqueta É o estágio. Contador
   * sai das conversas já carregadas (nada de round-trip por chip), e o
   * chip acende quando o filtro daquela etiqueta está ativo.
   */
  const funnelStages = useMemo(() => {
    const stages = tags
      .filter((t) => t.is_funnel_stage)
      .sort(
        (a, b) =>
          (a.funnel_position ?? 0) - (b.funnel_position ?? 0) ||
          a.name.localeCompare(b.name),
      );
    if (stages.length === 0) return [];

    const counts = new Map<string, number>();
    for (const conv of conversations) {
      for (const tag of conv.contact?.tags ?? []) {
        counts.set(tag.id, (counts.get(tag.id) ?? 0) + 1);
      }
    }
    return stages.map((tag) => ({ tag, count: counts.get(tag.id) ?? 0 }));
  }, [tags, conversations]);

  const filtered = useMemo(() => {
    let result = conversations;

    if (filter === "unread") {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter !== "all") {
      result = result.filter((c) => c.status === filter);
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    // Fixadas sobem para o topo (050). Não-fixada tem carimbo 0, então
    // `pb - pa` já joga as fixadas para cima e, entre elas, a fixada
    // mais recentemente na frente. Empate (ambas 0) devolve 0 e o sort
    // estável preserva a ordem original — mais recentes primeiro.
    result = [...result].sort((a, b) => {
      const pa = a.pinned_at ? new Date(a.pinned_at).getTime() : 0;
      const pb = b.pinned_at ? new Date(b.pinned_at).getTime() : 0;
      return pb - pa;
    });

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [conversations, filter, search, selectedTagIds, selectedCompany]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters = selectedTagIds.length > 0 || selectedCompany !== null;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      {/* Search + Filter */}
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder={t("searchPlaceholder")}
            className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {/* Chips de filtro estilo WhatsApp Web (Tudo | Não lidas | …) —
              sempre visíveis, um toque, sem menu escondido. */}
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setFilter(opt.value)}
              className={cn(
                "h-7 rounded-full px-3 text-xs transition-colors",
                filter === opt.value
                  ? "bg-wa-unread/25 font-medium text-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              {opt.label}
            </button>
          ))}

          {/* Etiquetas de funil viram chips com contador (046) — a
              visão de operação que o Jarbas tem na extensão. */}
          {funnelStages.map(({ tag, count }) => {
            const active = selectedTagIds.includes(tag.id);
            return (
              <button
                key={tag.id}
                type="button"
                onClick={() =>
                  setSelectedTagIds((prev) =>
                    prev.includes(tag.id)
                      ? prev.filter((id) => id !== tag.id)
                      : [...prev, tag.id],
                  )
                }
                title={tag.name}
                className={cn(
                  'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs capitalize transition-colors',
                  active
                    ? 'font-medium text-foreground'
                    : 'border-transparent bg-muted text-muted-foreground hover:text-foreground',
                )}
                style={
                  active
                    ? { borderColor: tag.color, backgroundColor: `${tag.color}22` }
                    : undefined
                }
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: tag.color }}
                />
                {tag.name}
                <span className="tabular-nums opacity-70">{count}</span>
              </button>
            );
          })}

          {/* Modo seleção múltipla (ações em massa). */}
          <button
            type="button"
            onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
            title={selectMode ? t("exitSelect") : t("selectChats")}
            aria-pressed={selectMode}
            className={cn(
              "ml-auto flex h-7 w-7 items-center justify-center rounded-full transition-colors",
              selectMode
                ? "bg-wa-unread/25 text-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            {selectMode ? <X className="h-3.5 w-3.5" /> : <ListChecks className="h-3.5 w-3.5" />}
          </button>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t("tags")}
                {selectedTagIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-wa-unread px-1 text-[10px] font-bold text-wa-unread-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedCompany
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{selectedCompany ?? t("company")}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {t("allCompanies")}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-24 truncate">{tag?.name ?? t("tags")}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {t("clearAll")}
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">{t("noConversations")}</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                t={t}
                selectMode={selectMode}
                selected={selectedIds.has(conv.id)}
                onToggleSelect={toggleSelected}
                onAction={handleRowAction}
              />
            ))}
          </div>
        )}
      </ScrollArea>

      {/* Barra de ações em massa (modo seleção). */}
      {selectMode && (
        <div className="flex items-center gap-1 border-t border-border bg-card px-2 py-2">
          <span className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground">
            {t("selectedCount", { n: selectedIds.size })}
          </span>
          <button
            type="button"
            disabled={acting || selectedIds.size === 0}
            onClick={() =>
              void applyConversationPatch(
                [...selectedIds],
                { unread_count: 1 },
                t("markedUnread"),
              )
            }
            title={t("markUnread")}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <MailPlus className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={acting || selectedIds.size === 0}
            onClick={() =>
              void applyConversationPatch(
                [...selectedIds],
                { status: "closed" },
                t("bulkClosed", { n: selectedIds.size }),
              )
            }
            title={t("closeConversation")}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <Archive className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={acting || selectedIds.size === 0}
            onClick={() =>
              void applyConversationPatch(
                [...selectedIds],
                { status: "open" },
                t("bulkReopened", { n: selectedIds.size }),
              )
            }
            title={t("reopenConversation")}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <ArchiveRestore className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={acting || selectedIds.size === 0}
            onClick={() => setDeleteTargets([...selectedIds])}
            title={t("deleteConversation")}
            className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-red-400 disabled:opacity-40"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Confirmação de exclusão — destrutivo de verdade (apaga o
          histórico da conversa no CRM; no WhatsApp do cliente nada muda). */}
      <Dialog
        open={deleteTargets !== null}
        onOpenChange={(open) => !open && setDeleteTargets(null)}
      >
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t("deleteTitle", { n: deleteTargets?.length ?? 0 })}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t("deleteDesc")}</p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTargets(null)}
              disabled={acting}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t("cancelAction")}
            </Button>
            <Button
              onClick={() => deleteTargets && void deleteConversations(deleteTargets)}
              disabled={acting}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {t("deleteConversation")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Ações do menu de contexto / barra de seleção (réplica WhatsApp Web). */
export type ConversationAction =
  | "pin"
  | "unpin"
  | "mark_unread"
  | "mark_read"
  | "close"
  | "reopen"
  | "delete";

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  t: ReturnType<typeof useTranslations>;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onAction: (action: ConversationAction, conversation: Conversation) => void;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  t,
  selectMode,
  selected,
  onToggleSelect,
  onAction,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || t("unknown");
  const initials = displayName.charAt(0).toUpperCase();

  const handleClick = useCallback(() => {
    if (selectMode) onToggleSelect(conversation.id);
    else onSelect(conversation);
  }, [selectMode, onToggleSelect, onSelect, conversation]);

  // Padrão WhatsApp Web: 14:05 · ontem · segunda-feira · 31/07/2026.
  const timeAgo = conversation.last_message_at
    ? formatWhatsAppTime(conversation.last_message_at)
    : "";

  return (
    // div-com-role em vez de <button>: o chevron do menu de contexto é
    // um botão próprio e HTML não permite botão dentro de botão.
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
      className={cn(
        "group relative flex w-full cursor-pointer items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        isActive && !selectMode && "border-l-2 border-primary bg-muted/70",
        selected && "bg-primary-soft"
      )}
    >
      {/* Avatar (vira alvo de seleção no modo múltiplo) */}
      <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
        {selectMode && (
          <span
            className={cn(
              "absolute -bottom-0.5 -right-0.5 flex h-4.5 w-4.5 items-center justify-center rounded-full border-2 border-card",
              selected
                ? "bg-wa-unread text-wa-unread-foreground"
                : "bg-muted text-transparent"
            )}
          >
            <Check className="h-3 w-3" />
          </span>
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {displayName}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
            {conversation.pinned_at && <Pin className="h-3 w-3 rotate-45" />}
            {timeAgo}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {conversation.last_message_text || t("noMessagesYet")}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {conversation.unread_count > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-wa-unread px-1 text-[10px] font-bold text-wa-unread-foreground">
                {conversation.unread_count}
              </span>
            )}
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                STATUS_COLORS[conversation.status]
              )}
              title={conversation.status}
            />
          </div>
        </div>
      </div>

      {/* Chevron de contexto (hover) — réplica do WhatsApp Web. */}
      {!selectMode && (
        <DropdownMenu>
          <DropdownMenuTrigger
            onClick={(e) => e.stopPropagation()}
            aria-label={t("rowMenu")}
            className="absolute right-2 top-2 rounded-md bg-card/80 p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover:opacity-100"
          >
            <ChevronDown className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="border-border bg-popover"
            onClick={(e) => e.stopPropagation()}
          >
            {conversation.pinned_at ? (
              <DropdownMenuItem onClick={() => onAction("unpin", conversation)}>
                <PinOff className="mr-2 h-3.5 w-3.5" />
                {t("unpinConversation")}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => onAction("pin", conversation)}>
                <Pin className="mr-2 h-3.5 w-3.5" />
                {t("pinConversation")}
              </DropdownMenuItem>
            )}
            {conversation.unread_count > 0 ? (
              <DropdownMenuItem onClick={() => onAction("mark_read", conversation)}>
                {t("markRead")}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => onAction("mark_unread", conversation)}>
                {t("markUnread")}
              </DropdownMenuItem>
            )}
            {conversation.status === "closed" ? (
              <DropdownMenuItem onClick={() => onAction("reopen", conversation)}>
                {t("reopenConversation")}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => onAction("close", conversation)}>
                {t("closeConversation")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => onAction("delete", conversation)}
              className="text-red-400 focus:text-red-400"
            >
              {t("deleteConversation")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
