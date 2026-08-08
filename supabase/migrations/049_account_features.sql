-- 049: Central de Recursos — liga/desliga tudo que é automático
--      (pedido do Jarbas, 05/08/2026)
--
-- "Quero um lugar pra ligar e desligar esses recursos, testar se está
--  funcionando, monitorar. Se eu quiser que seja só um aplicativo em que
--  eu entro e respondo mensagens de forma totalmente manual, é."
--
-- Um interruptor por recurso + um MESTRE ("modo manual") que derruba
-- tudo de uma vez. O padrão é LIGADO: um recurso sem linha aqui
-- funciona normalmente — assim nada quebra em contas existentes e
-- recursos novos não precisam de backfill.
--
-- Idempotente.

CREATE TABLE IF NOT EXISTS account_features (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  /**
   * Chave do recurso. Vocabulário canônico vive em
   * src/lib/features/catalog.ts — sem CHECK aqui de propósito, para
   * um recurso novo não exigir migration.
   *   modo_manual   — MESTRE: quando ligado, tudo automático para
   *   radar         — Radar de Leads (análise das conversas)
   *   followup      — agente de follow-up
   *   auto_reply    — bot que responde sozinho no inbox
   *   automations   — automações
   *   flows         — fluxos
   *   broadcasts    — envio de transmissões
   *   scheduled     — mensagens agendadas
   *   transcription — transcrever áudios recebidos
   *   vision        — interpretar fotos e documentos
   */
  feature TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (account_id, feature)
);

ALTER TABLE account_features ENABLE ROW LEVEL SECURITY;

-- Todo mundo LÊ (a UI mostra o estado para qualquer membro); só
-- admin+ mexe — desligar o agente afeta a operação inteira.
DROP POLICY IF EXISTS account_features_select ON account_features;
CREATE POLICY account_features_select ON account_features
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS account_features_modify ON account_features;
CREATE POLICY account_features_modify ON account_features
  FOR ALL USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- Realtime: quando alguém desliga um recurso, as abas abertas da
-- equipe refletem na hora.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND tablename = 'account_features'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE account_features;
  END IF;
END $$;
