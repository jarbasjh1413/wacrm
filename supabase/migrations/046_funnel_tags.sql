-- 046: etiquetas como estágios de funil (pedido do Jarbas, 05/08/2026)
--
-- A extensão que o Jarbas usa no WhatsApp Web mostra o funil em chips
-- com contadores no topo (QUALIFICAR 4085 | FRIO 432 | QUENTE 35 |
-- RESERVOU 4 | PAGO 603...). Aqui a etiqueta JÁ é o estágio — só
-- faltava marcar quais delas compõem o funil e em que ordem, para
-- virarem chips clicáveis no inbox.
--
-- Idempotente.

ALTER TABLE tags
  ADD COLUMN IF NOT EXISTS is_funnel_stage BOOLEAN NOT NULL DEFAULT FALSE;
-- Ordem no funil (0 = primeiro chip). Empates caem para ordem alfabética.
ALTER TABLE tags
  ADD COLUMN IF NOT EXISTS funnel_position INTEGER NOT NULL DEFAULT 0;

-- Consulta do inbox: "quais etiquetas formam o funil desta conta?"
CREATE INDEX IF NOT EXISTS idx_tags_funnel
  ON tags(account_id, funnel_position)
  WHERE is_funnel_stage;

-- As temperaturas do Radar (045) nascem no funil, na ordem natural do
-- calor. Só afeta as tags que o Radar já criou — nomes livres do
-- usuário continuam fora até ele marcar.
UPDATE tags SET is_funnel_stage = TRUE, funnel_position = 10 WHERE name = 'quente';
UPDATE tags SET is_funnel_stage = TRUE, funnel_position = 20 WHERE name = 'morno';
UPDATE tags SET is_funnel_stage = TRUE, funnel_position = 30 WHERE name = 'frio';
