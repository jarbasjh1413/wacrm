-- 044: agente de follow-up (FASE 5, CLAUDE.md §10)
--
-- "Nenhuma conversa comercial morre no esquecimento." O cron varre
-- conversas + os_events + deals, a IA redige, e:
--   automáticos (equipamento pronto, pós-venda) saem sozinhos e ficam
--   registrados como auto_sent; delicados (orçamento sem resposta,
--   lead frio) entram como pending na fila de /followups.
-- Idempotente.

-- 1. Sugestões ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS followup_suggestions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  -- Âncoras opcionais do cenário.
  os_id TEXT,
  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  cenario TEXT NOT NULL CHECK (cenario IN (
    'equipamento_pronto', 'pos_venda', 'orcamento_sem_resposta', 'lead_frio'
  )),
  mensagem_sugerida TEXT NOT NULL,
  justificativa_ia TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'approved', 'edited', 'discarded', 'sent', 'auto_sent'
  )),
  -- O que de fato saiu (= sugerida quando aprovada sem mexer; difere
  -- quando editada — essa diferença alimenta o aprendizado do prompt).
  mensagem_final TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  decided_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Máximo 1 pendente por conversa (regra do §10).
CREATE UNIQUE INDEX IF NOT EXISTS idx_followup_one_pending_per_conversation
  ON followup_suggestions(conversation_id)
  WHERE status = 'pending';
-- Fila e log, mais recentes primeiro.
CREATE INDEX IF NOT EXISTS idx_followup_account_status
  ON followup_suggestions(account_id, status, created_at DESC);
-- Cadência/tentativas por contato e cenário.
CREATE INDEX IF NOT EXISTS idx_followup_contact
  ON followup_suggestions(contact_id, created_at DESC);

ALTER TABLE followup_suggestions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS followup_suggestions_select ON followup_suggestions;
CREATE POLICY followup_suggestions_select ON followup_suggestions
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS followup_suggestions_modify ON followup_suggestions;
CREATE POLICY followup_suggestions_modify ON followup_suggestions
  FOR ALL USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

-- 2. Configurações por conta -------------------------------------------------

CREATE TABLE IF NOT EXISTS followup_settings (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- Prazos N (dias) por cenário — §10.
  dias_equipamento_pronto INTEGER NOT NULL DEFAULT 3 CHECK (dias_equipamento_pronto BETWEEN 1 AND 60),
  dias_pos_venda INTEGER NOT NULL DEFAULT 7 CHECK (dias_pos_venda BETWEEN 1 AND 60),
  dias_orcamento INTEGER NOT NULL DEFAULT 3 CHECK (dias_orcamento BETWEEN 1 AND 60),
  dias_lead_frio INTEGER NOT NULL DEFAULT 7 CHECK (dias_lead_frio BETWEEN 1 AND 90),
  -- Guardas anti-spam (§10 + §11).
  cadencia_minima_dias INTEGER NOT NULL DEFAULT 3 CHECK (cadencia_minima_dias BETWEEN 1 AND 30),
  max_tentativas INTEGER NOT NULL DEFAULT 3 CHECK (max_tentativas BETWEEN 1 AND 10),
  -- Última varredura (o relógio interno decide se é hora de rodar).
  last_scan_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE followup_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS followup_settings_select ON followup_settings;
CREATE POLICY followup_settings_select ON followup_settings
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS followup_settings_modify ON followup_settings;
CREATE POLICY followup_settings_modify ON followup_settings
  FOR ALL USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON followup_settings;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON followup_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
