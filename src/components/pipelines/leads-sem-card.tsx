"use client";

// Rede de segurança do funil de serviço (053): conversas recentes com cara
// de conserto que NÃO viraram card — a IA devolveu funil nulo, o quadro
// não existia na hora, ou a análise ainda não rodou. Sem esta lista, o
// recurso pode falhar por semanas sem sintoma: o board fica vazio e parece
// que não há demanda. Só aparece quando o funil selecionado é de serviço.

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertTriangle, Plus } from "lucide-react";

interface LeadSemCard {
  conversationId: string;
  contactId: string;
  nome: string;
  interesse: string | null;
  intencao: string;
}

interface LeadsSemCardProps {
  pipelineId: string;
  /** Primeira coluna do funil — onde o card criado pelo botão nasce. */
  firstStageId: string | null;
  /** Recarrega o board depois de criar um card. */
  onDealCreated: () => void;
}

const DIAS_JANELA = 15;

export function LeadsSemCard({
  pipelineId,
  firstStageId,
  onDealCreated,
}: LeadsSemCardProps) {
  const t = useTranslations("Pipelines.leadsSemCard");
  const { accountId } = useAuth();
  const [leads, setLeads] = useState<LeadSemCard[]>([]);
  const [criando, setCriando] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    if (!accountId) return;
    const supabase = createClient();
    const desde = new Date(
      Date.now() - DIAS_JANELA * 24 * 60 * 60 * 1000,
    ).toISOString();

    // Conversas recentes com intenção de conserto…
    const { data: insights } = await supabase
      .from("conversation_insights")
      .select(
        "conversation_id, intencao, interesse, conversation:conversations!inner(id, contact_id, last_message_at, contact:contacts(id, name, phone))",
      )
      .in("intencao", ["assistencia", "pos_venda"])
      .gte("conversation.last_message_at", desde);

    // …menos as que já têm card aberto neste funil.
    const { data: existentes } = await supabase
      .from("deals")
      .select("contact_id")
      .eq("pipeline_id", pipelineId)
      .neq("status", "lost");
    const comCard = new Set((existentes ?? []).map((d) => d.contact_id));

    const rows: LeadSemCard[] = [];
    for (const raw of (insights ?? []) as Record<string, unknown>[]) {
      const convRaw = raw.conversation;
      const conv = Array.isArray(convRaw) ? convRaw[0] : convRaw;
      if (!conv) continue;
      const c = conv as {
        contact_id: string | null;
        contact?: { id: string; name: string | null; phone: string | null } | null;
      };
      const contatoRaw = c.contact as unknown;
      const contato = Array.isArray(contatoRaw) ? contatoRaw[0] : contatoRaw;
      if (!c.contact_id || comCard.has(c.contact_id)) continue;
      rows.push({
        conversationId: raw.conversation_id as string,
        contactId: c.contact_id,
        nome:
          (contato as { name?: string | null })?.name ??
          (contato as { phone?: string | null })?.phone ??
          "?",
        interesse: (raw.interesse as string | null) ?? null,
        intencao: raw.intencao as string,
      });
    }
    setLeads(rows);
  }, [accountId, pipelineId]);

  useEffect(() => {
    // Padrão do projeto: fetch assíncrono que hidrata estado ao trocar de funil.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void carregar();
  }, [carregar]);

  const criarCard = useCallback(
    async (lead: LeadSemCard) => {
      if (!accountId || !firstStageId) return;
      setCriando(lead.conversationId);
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.user) return;
      const { error } = await supabase.from("deals").insert({
        account_id: accountId,
        user_id: session.user.id,
        pipeline_id: pipelineId,
        stage_id: firstStageId,
        contact_id: lead.contactId,
        conversation_id: lead.conversationId,
        title: lead.interesse
          ? `${lead.nome} — ${lead.interesse}`.slice(0, 120)
          : lead.nome,
        value: 0,
        currency: "BRL",
        status: "open",
      });
      setCriando(null);
      if (error) {
        toast.error(t("createFailed"));
        return;
      }
      toast.success(t("created"));
      setLeads((prev) =>
        prev.filter((l) => l.conversationId !== lead.conversationId),
      );
      onDealCreated();
    },
    [accountId, firstStageId, pipelineId, t, onDealCreated],
  );

  if (leads.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="flex items-center gap-2 text-xs font-medium text-amber-500">
        <AlertTriangle className="h-3.5 w-3.5" />
        {t("title", { count: leads.length })}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">{t("hint")}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {leads.map((lead) => (
          <div
            key={lead.conversationId}
            className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5"
          >
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-foreground">
                {lead.nome}
              </p>
              {lead.interesse && (
                <p className="max-w-[16rem] truncate text-[10px] text-muted-foreground">
                  {lead.interesse}
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={criando === lead.conversationId || !firstStageId}
              onClick={() => void criarCard(lead)}
              title={t("createCard")}
              className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-2 py-1 text-[10px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <Plus className="h-3 w-3" />
              {t("createCard")}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
