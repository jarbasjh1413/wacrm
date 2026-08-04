-- 039: broadcasts inteligentes (mensagens livres + fila anti-ban)
--
-- Reforma dos broadcasts para o motor Evolution (CLAUDE.md §6.5 + §11):
--   1. broadcasts.message_text — corpo livre com variáveis {{nome}} etc.
--      (template_name vira NULLABLE; broadcasts antigos da era Meta o mantêm).
--   2. broadcasts.next_send_at — relógio da fila: o drenador do servidor só
--      envia o próximo destinatário quando now() >= next_send_at, e a cada
--      envio reagenda com jitter aleatório de 30–120s (anti-ban §11.1).
--   3. broadcast_limits — limites anti-ban por conta (§11.2 e §11.3):
--      teto diário, janela de horário comercial e faixa de delay.
--
-- Idempotente: pode rodar mais de uma vez sem efeito colateral.

-- 1. Conteúdo livre -------------------------------------------------------

ALTER TABLE broadcasts ALTER COLUMN template_name DROP NOT NULL;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS message_text TEXT;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS next_send_at TIMESTAMPTZ;

-- Todo broadcast precisa de um conteúdo: template (era Meta) OU texto livre.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'broadcasts_content_check'
  ) THEN
    ALTER TABLE broadcasts
      ADD CONSTRAINT broadcasts_content_check
      CHECK (template_name IS NOT NULL OR message_text IS NOT NULL);
  END IF;
END $$;

-- Índice da fila: o drenador busca broadcasts 'sending'/'scheduled' devidos.
CREATE INDEX IF NOT EXISTS idx_broadcasts_queue
  ON broadcasts (status, next_send_at)
  WHERE status IN ('scheduled', 'sending');

-- Contagem do teto diário (JOIN por broadcast + filtro em sent_at).
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_sent_at
  ON broadcast_recipients (sent_at)
  WHERE sent_at IS NOT NULL;

-- 2. Limites anti-ban por conta ------------------------------------------

CREATE TABLE IF NOT EXISTS broadcast_limits (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  -- §11.2 — máximo de mensagens de broadcast por dia na conta.
  daily_cap INTEGER NOT NULL DEFAULT 50 CHECK (daily_cap > 0),
  -- §11.1 — faixa do delay aleatório entre envios, em segundos.
  min_delay_seconds INTEGER NOT NULL DEFAULT 30 CHECK (min_delay_seconds >= 5),
  max_delay_seconds INTEGER NOT NULL DEFAULT 120,
  -- §11.3 — janela de envio (horas locais, [start, end)) e dias permitidos
  -- (0 = domingo … 6 = sábado; padrão seg–sáb).
  send_window_start SMALLINT NOT NULL DEFAULT 9
    CHECK (send_window_start BETWEEN 0 AND 23),
  send_window_end SMALLINT NOT NULL DEFAULT 18
    CHECK (send_window_end BETWEEN 1 AND 24),
  send_days SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5,6}',
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (max_delay_seconds >= min_delay_seconds),
  CHECK (send_window_end > send_window_start)
);

ALTER TABLE broadcast_limits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS broadcast_limits_select ON broadcast_limits;
CREATE POLICY broadcast_limits_select ON broadcast_limits
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS broadcast_limits_insert ON broadcast_limits;
CREATE POLICY broadcast_limits_insert ON broadcast_limits
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS broadcast_limits_update ON broadcast_limits;
CREATE POLICY broadcast_limits_update ON broadcast_limits
  FOR UPDATE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS broadcast_limits_delete ON broadcast_limits;
CREATE POLICY broadcast_limits_delete ON broadcast_limits
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- Trigger de updated_at (função já existe desde a 001).
DROP TRIGGER IF EXISTS set_updated_at ON broadcast_limits;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON broadcast_limits
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
