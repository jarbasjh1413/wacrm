-- 050: fixar conversa no topo da lista (pedido do Jarbas, 05/08/2026)
--
-- Réplica do "Fixar conversa" do WhatsApp: as fixadas sobem para o topo
-- da lista, acima de tudo, com um alfinete. É por CONTA (não por
-- usuário): a lista do inbox é compartilhada pela equipe, então uma
-- conversa fixada é fixada para todo mundo — o que é o comportamento
-- desejado numa operação em que todos atendem o mesmo funil.
--
-- Idempotente.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;

-- Ordenação da lista: fixadas primeiro, mais recentes no topo.
CREATE INDEX IF NOT EXISTS idx_conversations_pinned
  ON conversations(account_id, pinned_at DESC)
  WHERE pinned_at IS NOT NULL;
