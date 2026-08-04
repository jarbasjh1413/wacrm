// ============================================================
// POST /api/v1/os-events — ingest de eventos do sistema de OS
// (FASE 4, CLAUDE.md §9). Escopo: os:write.
//
// O sistema de ordens de serviço (projeto separado) chama este
// endpoint a cada evento relevante (status alterado, OS criada,
// entregue...). O CRM resolve o contato pelo telefone — criando se
// não existir, mesmo caminho find-or-create da API de contatos — e
// grava o evento em os_events, que alimenta a lateral da conversa e
// o agente de follow-up (Fase 5).
//
// Contrato completo em docs/integracao-os.md.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  findOrCreateContact,
  resolveAuditUserId,
  ContactError,
} from '@/lib/api/v1/contacts';

interface OsEventBody {
  os_id?: unknown;
  evento?: unknown;
  status?: unknown;
  cliente?: { nome?: unknown; telefone?: unknown };
  equipamento?: unknown;
  valor_orcamento?: unknown;
  data_evento?: unknown;
  unidade?: unknown;
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'os:write');

    const body = (await request.json().catch(() => null)) as OsEventBody | null;
    if (!body) return fail('invalid_json', 'Body must be valid JSON', 400);

    const osId = asTrimmedString(body.os_id);
    const evento = asTrimmedString(body.evento);
    const telefone = asTrimmedString(body.cliente?.telefone);
    if (!osId) return fail('validation', "'os_id' is required", 400);
    if (!evento) return fail('validation', "'evento' is required", 400);
    if (!telefone) {
      return fail('validation', "'cliente.telefone' is required", 400);
    }

    const dataEventoRaw = asTrimmedString(body.data_evento);
    const dataEvento = dataEventoRaw ? new Date(dataEventoRaw) : new Date();
    if (Number.isNaN(dataEvento.getTime())) {
      return fail(
        'validation',
        "'data_evento' must be an ISO-8601 timestamp",
        400,
      );
    }

    const valorRaw = body.valor_orcamento;
    const valor =
      typeof valorRaw === 'number' && Number.isFinite(valorRaw)
        ? valorRaw
        : null;

    // Contato: mesmo find-or-create da API de contatos (valida E.164,
    // dedupe compartilhado com o webhook do WhatsApp).
    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);
    const contact = await findOrCreateContact(
      ctx.supabase,
      ctx.accountId,
      auditUserId,
      {
        phone: telefone,
        name: asTrimmedString(body.cliente?.nome) ?? undefined,
      },
    );

    const { data: event, error } = await ctx.supabase
      .from('os_events')
      .insert({
        account_id: ctx.accountId,
        os_id: osId,
        evento,
        status: asTrimmedString(body.status),
        contact_id: contact.id,
        cliente_nome: asTrimmedString(body.cliente?.nome),
        cliente_telefone: telefone,
        equipamento: asTrimmedString(body.equipamento),
        valor_orcamento: valor,
        unidade: asTrimmedString(body.unidade),
        data_evento: dataEvento.toISOString(),
        payload: body,
      })
      .select('id, os_id, evento, status, contact_id, data_evento, created_at')
      .single();
    if (error || !event) {
      console.error('[v1/os-events] insert failed:', error?.message);
      return fail('internal', 'Failed to store the event', 500);
    }

    return ok(
      { event, contact: { id: contact.id, created: contact.created } },
      201,
    );
  } catch (err) {
    if (err instanceof ContactError) {
      return fail('validation', err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}
