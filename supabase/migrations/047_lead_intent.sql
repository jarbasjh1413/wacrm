-- 047: intenção do lead + aprendizado com o humano (visão do Jarbas, 05/08/2026)
--
-- "No nosso WhatsApp chegam leads diferentes: quem já comprou e precisa
-- de assistência, quem só quer uma informação, quem quer comprar, quem
-- quer trazer pra manutenção — e cada situação tem caminhos diferentes."
--
-- Temperatura (045) responde QUÃO perto de comprar. Intenção responde
-- O QUE a pessoa quer. São eixos independentes: dá para ter alguém
-- QUENTE de assistência (equipamento parado, quer consertar hoje) e
-- MORNO de compra. Cada um pede um caminho diferente de atendimento.
--
-- Idempotente.

-- 1. Intenção -----------------------------------------------------------------

ALTER TABLE conversation_insights
  ADD COLUMN IF NOT EXISTS intencao TEXT NOT NULL DEFAULT 'indefinido';

DO $$
BEGIN
  ALTER TABLE conversation_insights DROP CONSTRAINT IF EXISTS conversation_insights_intencao_check;
  ALTER TABLE conversation_insights ADD CONSTRAINT conversation_insights_intencao_check
    CHECK (intencao IN (
      'compra',       -- quer comprar um equipamento
      'assistencia',  -- equipamento com defeito, quer consertar
      'orcamento',    -- quer saber preço de um serviço/reparo
      'informacao',   -- dúvida geral, horário, endereço, se trabalha com X
      'pos_venda',    -- já é cliente: garantia, revisão, retorno
      'outro',        -- não comercial (conversa pessoal, fornecedor, spam)
      'indefinido'    -- ainda sem sinal
    ));
END $$;

-- Chips de funil por intenção + varredura do agente.
CREATE INDEX IF NOT EXISTS idx_conversation_insights_intencao
  ON conversation_insights(account_id, intencao);

-- 2. Correções humanas (o "consenso IA + humano") -----------------------------
-- Quando o atendente corrige a classificação, a diferença vira exemplo
-- para as próximas análises da conta — é assim que o Radar aprende o
-- jeito da Oficina sem ninguém escrever prompt.

CREATE TABLE IF NOT EXISTS radar_corrections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  /** 'temperatura' | 'intencao' */
  campo TEXT NOT NULL CHECK (campo IN ('temperatura', 'intencao')),
  valor_ia TEXT NOT NULL,
  valor_humano TEXT NOT NULL,
  /** Trecho do resumo na hora da correção — o "por quê" do exemplo. */
  contexto TEXT,
  corrigido_por UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- As correções mais recentes viram exemplos no prompt.
CREATE INDEX IF NOT EXISTS idx_radar_corrections_account
  ON radar_corrections(account_id, created_at DESC);

ALTER TABLE radar_corrections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS radar_corrections_select ON radar_corrections;
CREATE POLICY radar_corrections_select ON radar_corrections
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS radar_corrections_insert ON radar_corrections;
CREATE POLICY radar_corrections_insert ON radar_corrections
  FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));

-- 3. A classificação humana é soberana ----------------------------------------
-- Corrigiu? A IA não sobrescreve mais aquele campo (só complementa o
-- resto do dossiê). Sem isso o atendente corrigiria a mesma conversa
-- toda vez que chegasse mensagem nova.

ALTER TABLE conversation_insights
  ADD COLUMN IF NOT EXISTS temperatura_fixada_em TIMESTAMPTZ;
ALTER TABLE conversation_insights
  ADD COLUMN IF NOT EXISTS intencao_fixada_em TIMESTAMPTZ;

-- O card do Radar é editável pelo atendente (só estes campos; o resto
-- do dossiê continua exclusivo do service role).
DROP POLICY IF EXISTS conversation_insights_update ON conversation_insights;
CREATE POLICY conversation_insights_update ON conversation_insights
  FOR UPDATE USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));
