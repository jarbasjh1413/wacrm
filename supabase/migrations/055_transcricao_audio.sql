-- 055: transcrição de áudio (item 1 da pesquisa docs/multimidia-ia.md)
--
-- O Claude não escuta áudio; o caminho é o speechToText nativo da
-- Evolution (Whisper da OpenAI por baixo, ~R$ 4,60/mês no volume da
-- Oficina). A chave da OpenAI é do dono (BYO), colada por ele na tela e
-- guardada AES-256-GCM como a chave da Anthropic — nunca volta ao client.
--
-- Idempotente.

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS transcricao_api_key TEXT;

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS transcricao_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN ai_configs.transcricao_api_key IS
  'Chave da OpenAI (Whisper) criptografada — só para o speechToText da Evolution.';
COMMENT ON COLUMN ai_configs.transcricao_enabled IS
  'Transcrição de áudio ligada nas instâncias Evolution da conta.';
