-- 043: os_events — eventos do sistema de ordens de serviço (FASE 4, §9)
--
-- O sistema de OS (projeto separado, banco separado) avisa o CRM a cada
-- mudança relevante via POST /api/v1/os-events (autenticado por
-- api_key). O CRM resolve o contato pelo telefone (cria se faltar),
-- guarda o evento aqui e passa a alimentar: a lateral da conversa
-- (OSs do cliente), automações e o agente de follow-up da Fase 5
-- ("equipamento pronto não retirado há N dias" etc.).
--
-- Modelo: uma linha POR EVENTO (histórico completo, não snapshot).
-- O estado atual de uma OS é o evento mais recente do seu os_id.
-- Idempotente.

CREATE TABLE IF NOT EXISTS os_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Identificador da OS no sistema de origem (texto: "1234", "OS-2026-001"...).
  os_id TEXT NOT NULL,
  -- Tipo do evento reportado (ex.: status_alterado, os_criada, os_entregue).
  evento TEXT NOT NULL,
  -- Status da OS no momento do evento (pronto | orcamento_enviado |
  -- aguardando_aprovacao | entregue | ... — vocabulário do sistema de OS,
  -- deliberadamente sem CHECK para o CRM não quebrar quando a Oficina
  -- criar um status novo lá).
  status TEXT,
  -- Contato resolvido pelo telefone no momento do ingest (nullable: o
  -- evento fica registrado mesmo se o contato for apagado depois).
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  cliente_nome TEXT,
  cliente_telefone TEXT NOT NULL,
  equipamento TEXT,
  valor_orcamento NUMERIC(12, 2),
  unidade TEXT,
  -- Quando o evento aconteceu NO SISTEMA DE OS (created_at = quando chegou aqui).
  data_evento TIMESTAMPTZ NOT NULL,
  -- Payload bruto recebido — à prova de evolução do contrato.
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lateral da conversa: "OSs deste contato, mais recentes primeiro".
CREATE INDEX IF NOT EXISTS idx_os_events_contact
  ON os_events(contact_id, data_evento DESC);
-- Estado atual de uma OS + dedupe de reenvios.
CREATE INDEX IF NOT EXISTS idx_os_events_os
  ON os_events(account_id, os_id, data_evento DESC);
-- Varredura do agente de follow-up (Fase 5): eventos por status.
CREATE INDEX IF NOT EXISTS idx_os_events_account_status
  ON os_events(account_id, status, data_evento DESC);

ALTER TABLE os_events ENABLE ROW LEVEL SECURITY;

-- Leitura: qualquer membro da conta (a lateral do inbox é de todos).
DROP POLICY IF EXISTS os_events_select ON os_events;
CREATE POLICY os_events_select ON os_events
  FOR SELECT USING (is_account_member(account_id));

-- Escrita: só via API v1 (service role, que ignora RLS). Membros não
-- criam/editam eventos pela UI — a fonte da verdade é o sistema de OS.
