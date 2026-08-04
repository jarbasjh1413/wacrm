-- 040: scripts de mensagens + agendamento (FASE 3, CLAUDE.md §8)
--
-- Substitui a extensão WA Scale:
--   1. message_scripts / message_script_items — sequências prontas
--      ("Garantia" = vídeo + 2 textos) disparadas com um clique na
--      conversa. Itens ordenados, tipo texto|midia, com pausa natural
--      (delay_seconds) entre eles e variáveis {{nome}} etc.
--   2. scheduled_messages — escrever agora, enviar depois: um texto OU
--      um script inteiro, para uma conversa, numa data/hora. Drenado
--      pelo relógio do servidor (instrumentation + /api/scheduled/cron).
--
-- Idempotente.

-- 1. Scripts ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS message_scripts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_scripts_account
  ON message_scripts(account_id);

CREATE TABLE IF NOT EXISTS message_script_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  script_id UUID NOT NULL REFERENCES message_scripts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('text', 'image', 'video', 'document', 'audio')),
  -- texto: corpo da mensagem (com variáveis). mídia: legenda opcional.
  content_text TEXT,
  -- mídia: URL pública no bucket chat-media + path para GC.
  media_url TEXT,
  media_path TEXT,
  filename TEXT,
  -- Pausa ANTES de enviar este item (a partir do anterior), em segundos.
  delay_seconds INTEGER NOT NULL DEFAULT 4
    CHECK (delay_seconds BETWEEN 0 AND 300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (item_type = 'text' AND content_text IS NOT NULL)
    OR (item_type <> 'text' AND media_url IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_message_script_items_script
  ON message_script_items(script_id, position);

ALTER TABLE message_scripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_script_items ENABLE ROW LEVEL SECURITY;

-- Leitura: qualquer membro. Escrita: agente pra cima (mesmo modelo dos
-- quick replies — scripts são ferramenta operacional do time).
DROP POLICY IF EXISTS message_scripts_select ON message_scripts;
CREATE POLICY message_scripts_select ON message_scripts
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS message_scripts_modify ON message_scripts;
CREATE POLICY message_scripts_modify ON message_scripts
  FOR ALL USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS message_script_items_select ON message_script_items;
CREATE POLICY message_script_items_select ON message_script_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM message_scripts s
      WHERE s.id = script_id AND is_account_member(s.account_id)
    )
  );
DROP POLICY IF EXISTS message_script_items_modify ON message_script_items;
CREATE POLICY message_script_items_modify ON message_script_items
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM message_scripts s
      WHERE s.id = script_id AND is_account_member(s.account_id, 'agent')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM message_scripts s
      WHERE s.id = script_id AND is_account_member(s.account_id, 'agent')
    )
  );

DROP TRIGGER IF EXISTS set_updated_at ON message_scripts;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON message_scripts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 2. Mensagens agendadas ---------------------------------------------------

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Conteúdo: texto livre OU um script inteiro.
  content_text TEXT,
  script_id UUID REFERENCES message_scripts(id) ON DELETE CASCADE,
  send_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'sent', 'canceled', 'failed')),
  error_message TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (content_text IS NOT NULL OR script_id IS NOT NULL)
);

-- Fila: o drenador busca 'scheduled' vencidas.
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due
  ON scheduled_messages(status, send_at)
  WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_account
  ON scheduled_messages(account_id, created_at DESC);

ALTER TABLE scheduled_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scheduled_messages_select ON scheduled_messages;
CREATE POLICY scheduled_messages_select ON scheduled_messages
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS scheduled_messages_modify ON scheduled_messages;
CREATE POLICY scheduled_messages_modify ON scheduled_messages
  FOR ALL USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));
