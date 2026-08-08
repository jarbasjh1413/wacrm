-- 048: campos preenchidos pela IA + categorias de scripts/respostas
--      (pedidos do Jarbas, 05/08/2026)
--
-- (a) "A IA poderia criar campos personalizados e já ir preenchendo
--     conforme entende do cliente — cidade, de onde é, trabalho."
--     O CRM já tem custom_fields + contact_custom_values; faltava
--     marcar o que veio da IA (para o atendente saber a origem do dado
--     e a IA não pisar em cima do que gente preencheu à mão).
--
-- (b) "Painel de scripts por categoria do lado" — réplica do painel
--     direito da extensão (VENDAS → rapido, GARANTIA, SEQ1-4...).
--
-- Idempotente.

-- 1. Campos que a IA pode manter ---------------------------------------------

ALTER TABLE custom_fields
  ADD COLUMN IF NOT EXISTS ai_managed BOOLEAN NOT NULL DEFAULT FALSE;
-- Dica em português para a IA saber o que colocar ali ("cidade onde o
-- cliente mora", "profissão/uso do equipamento").
ALTER TABLE custom_fields
  ADD COLUMN IF NOT EXISTS ai_hint TEXT;

-- Origem do valor: 'ai' | 'human'. Humano é soberano — a IA só escreve
-- em campo vazio ou que ela mesma preencheu.
ALTER TABLE contact_custom_values
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'human'
    CHECK (source IN ('ai', 'human'));
ALTER TABLE contact_custom_values
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_custom_fields_ai
  ON custom_fields(account_id)
  WHERE ai_managed;

-- Campos-semente que a IA preenche sozinha: são os que o Jarbas citou.
-- Criados por conta, sem duplicar se já existir um com o mesmo nome.
DO $$
DECLARE
  acct RECORD;
  owner_id UUID;
  seed RECORD;
BEGIN
  FOR acct IN SELECT id FROM accounts LOOP
    SELECT user_id INTO owner_id
      FROM profiles
     WHERE account_id = acct.id
     ORDER BY (account_role = 'owner') DESC, created_at ASC
     LIMIT 1;
    CONTINUE WHEN owner_id IS NULL;

    FOR seed IN
      SELECT * FROM (VALUES
        ('Cidade',      'Cidade ou bairro onde o cliente mora ou trabalha'),
        ('Profissão',   'Profissão, ramo ou para que o cliente usa o equipamento'),
        ('Equipamento', 'Marca/modelo do equipamento que o cliente tem ou procura'),
        ('Como chegou', 'Canal ou indicação que trouxe o cliente até a loja')
      ) AS t(nome, dica)
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM custom_fields
         WHERE account_id = acct.id AND field_name = seed.nome
      ) THEN
        INSERT INTO custom_fields (account_id, user_id, field_name, field_type, ai_managed, ai_hint)
        VALUES (acct.id, owner_id, seed.nome, 'text', TRUE, seed.dica);
      ELSE
        UPDATE custom_fields
           SET ai_managed = TRUE, ai_hint = COALESCE(ai_hint, seed.dica)
         WHERE account_id = acct.id AND field_name = seed.nome;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- 2. Categorias de scripts e respostas rápidas -------------------------------

ALTER TABLE quick_replies
  ADD COLUMN IF NOT EXISTS categoria TEXT;
ALTER TABLE message_scripts
  ADD COLUMN IF NOT EXISTS categoria TEXT;

CREATE INDEX IF NOT EXISTS idx_quick_replies_categoria
  ON quick_replies(account_id, categoria);
CREATE INDEX IF NOT EXISTS idx_message_scripts_categoria
  ON message_scripts(account_id, categoria);
