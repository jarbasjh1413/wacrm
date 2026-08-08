-- 045: Radar de Leads — memória de conversa (FASE 6, CLAUDE.md §10.5)
--
-- A IA lê as conversas e monta o dossiê vivo de cada lead: temperatura,
-- interesse, resumo, momentos-chave e a DATA PROMETIDA pelo cliente
-- ("vou comprar dia 20") — que vira follow-up agendado. Quando o lead
-- esquenta ("consegui o adiantamento"), marca para escalar a um humano.
--
-- Uma linha POR CONVERSA (dossiê atualizado a cada análise); o
-- histórico fica em `momentos` (append-only, JSONB).
-- Idempotente.

-- 1. Dossiê por conversa -----------------------------------------------------

CREATE TABLE IF NOT EXISTS conversation_insights (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Uma conversa tem no máximo um dossiê (upsert por análise).
  conversation_id UUID NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,

  -- Classificação segundo os critérios que o dono ensinou em português
  -- (followup_settings.criterios_*).
  temperatura TEXT NOT NULL DEFAULT 'indefinido'
    CHECK (temperatura IN ('quente', 'morno', 'frio', 'indefinido')),
  /** O que o cliente quer, em uma frase ("notebook gamer até R$ 3.500"). */
  interesse TEXT,
  /** Resumo vivo da conversa — reescrito a cada análise. */
  resumo TEXT,
  /**
   * Momentos-chave acumulados (append-only):
   *   [{ "em": ISO, "tipo": "promessa_data|objecao|orcamento|interesse|pessoal",
   *      "texto": "disse que compra dia 20" }]
   */
  momentos JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Promessa do cliente virando ação: o agente de follow-up dispara o
  -- cenário 'promessa' nesta data (prioridade sobre os genéricos).
  proximo_contato_em TIMESTAMPTZ,
  proximo_contato_motivo TEXT,
  /** Consumido quando o follow-up de promessa é criado (evita repetir). */
  promessa_atendida_em TIMESTAMPTZ,

  -- Escalada para humano (lead esquentou).
  escalado_em TIMESTAMPTZ,
  escalado_motivo TEXT,

  -- Controle do analisador (debounce + "há mensagem nova desde a última?").
  ultima_analise_em TIMESTAMPTZ,
  ultima_mensagem_analisada_em TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Chips de funil com contadores + página Jornada.
CREATE INDEX IF NOT EXISTS idx_conversation_insights_temperatura
  ON conversation_insights(account_id, temperatura);
-- Varredura do cenário 'promessa' no engine de follow-up.
CREATE INDEX IF NOT EXISTS idx_conversation_insights_proximo_contato
  ON conversation_insights(account_id, proximo_contato_em)
  WHERE proximo_contato_em IS NOT NULL AND promessa_atendida_em IS NULL;
CREATE INDEX IF NOT EXISTS idx_conversation_insights_contact
  ON conversation_insights(contact_id);

ALTER TABLE conversation_insights ENABLE ROW LEVEL SECURITY;

-- Leitura: qualquer membro (o card aparece na lateral pra todo mundo).
-- Escrita: service role (o analisador) — agentes não editam o dossiê à mão.
DROP POLICY IF EXISTS conversation_insights_select ON conversation_insights;
CREATE POLICY conversation_insights_select ON conversation_insights
  FOR SELECT USING (is_account_member(account_id));

DROP TRIGGER IF EXISTS set_updated_at ON conversation_insights;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON conversation_insights
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 2. Critérios ensinados + interruptor do Radar ------------------------------
-- Moram em followup_settings (044) — é a mesma "central do agente".

ALTER TABLE followup_settings
  ADD COLUMN IF NOT EXISTS radar_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE followup_settings
  ADD COLUMN IF NOT EXISTS contexto_negocio TEXT;
ALTER TABLE followup_settings
  ADD COLUMN IF NOT EXISTS criterios_quente TEXT;
ALTER TABLE followup_settings
  ADD COLUMN IF NOT EXISTS criterios_morno TEXT;
ALTER TABLE followup_settings
  ADD COLUMN IF NOT EXISTS criterios_frio TEXT;
-- Minutos de silêncio antes de analisar (deixa a conversa "assentar").
ALTER TABLE followup_settings
  ADD COLUMN IF NOT EXISTS radar_debounce_minutos INTEGER NOT NULL DEFAULT 10
    CHECK (radar_debounce_minutos BETWEEN 1 AND 240);

-- 3. Cenário 'promessa' no agente de follow-up -------------------------------
-- O mais valioso: cobrar exatamente na data que o cliente prometeu.

ALTER TABLE followup_suggestions DROP CONSTRAINT IF EXISTS followup_suggestions_cenario_check;
ALTER TABLE followup_suggestions ADD CONSTRAINT followup_suggestions_cenario_check
  CHECK (cenario IN (
    'equipamento_pronto', 'pos_venda', 'orcamento_sem_resposta', 'lead_frio', 'promessa'
  ));

-- 4. Consumo de IA do Radar e do agente aparece no painel de Uso -------------
-- (033 só previa auto_reply e draft.)

ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_mode_check;
ALTER TABLE ai_usage_log ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN ('auto_reply', 'draft', 'radar', 'followup'));
