-- 053: funil de serviço x funil de vendas (pedido do Jarbas, 08/08/2026)
--
-- "Seria legal diferenciar funil de serviço e funil de vendas. O Radar
--  poderia fazer essa diferenciação: se o cliente quer serviço, criar ele
--  dentro de um funil de serviço, onde a tentativa é trazer o cliente pra
--  loja, ou coletar alguma máquina."
--
-- O funil de serviço do CRM é o PRÉ-LOJA. O sistema de OS dele já tem um
-- kanban de 12 colunas com a verdade do conserto (ver docs/funil-servico.md);
-- reproduzir aquilo aqui garantiria que os dois discordassem. Então este
-- funil vai da primeira mensagem no WhatsApp até a máquina entrar na
-- bancada — e o "ganho" dele é a máquina na mesa, não dinheiro.
--
-- Reaproveita as MESMAS seis palavras canônicas da 051 (novo/qualificado/
-- negociando/reservado/ganho/perdido). Assim nenhum CHECK muda, o código de
-- ordenação não muda, e a 052 é no-op genuíno neste funil (os guardas dela
-- são por radar_stage e por nome exato em inglês — conferidos um a um).
--
-- Idempotente. Nenhum negócio existente muda de funil, coluna ou status.

-- 1. O carimbo do funil ------------------------------------------------------

ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'vendas';

DO $$
BEGIN
  ALTER TABLE pipelines DROP CONSTRAINT IF EXISTS pipelines_tipo_check;
  ALTER TABLE pipelines ADD CONSTRAINT pipelines_tipo_check
    CHECK (tipo IN ('vendas', 'servico'));
END $$;

-- O Radar escolhe "o mais antigo DAQUELE tipo" — por isso created_at entra.
CREATE INDEX IF NOT EXISTS idx_pipelines_account_tipo
  ON pipelines(account_id, tipo, created_at);

-- 2. O que o negócio passa a guardar -----------------------------------------

-- deals não tinha motivo de perda. Sem ele, "o conserto virou venda" é uma
-- perda invisível — e é justamente o número que o Jarbas vai querer ver.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS motivo_perda TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS motivo_perda_obs TEXT;

DO $$
BEGIN
  ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_motivo_perda_check;
  ALTER TABLE deals ADD CONSTRAINT deals_motivo_perda_check
    CHECK (motivo_perda IS NULL OR motivo_perda IN (
      'virou_venda',       -- conserto inviável → comprou máquina
      'virou_servico',     -- veio comprar, acabou consertando
      'resolvido_sem_os',  -- resolvido no WhatsApp/remoto — NÃO é perda real
      'preco',
      'nao_apareceu',      -- combinou trazer e sumiu
      'sem_resposta',
      'concorrente',
      'funil_errado',      -- a IA classificou errado e o humano corrigiu
      'outro'));
END $$;

-- A ponte entre os dois quadros. Escrita SÓ por gente (botão "Virou venda"):
-- se a IA amarrasse sozinha, o cliente que conserta E compra — que é o
-- cliente comum da loja — entraria no relatório como conversão.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS relacionado_deal_id UUID
  REFERENCES deals(id) ON DELETE SET NULL;

-- Espelho da OS no card. VITRINE, não fonte da verdade.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS os_id TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS os_status TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS os_atualizada_em TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_deals_contato_funil
  ON deals(account_id, contact_id, pipeline_id) WHERE status <> 'lost';
CREATE INDEX IF NOT EXISTS idx_deals_relacionado
  ON deals(relacionado_deal_id) WHERE relacionado_deal_id IS NOT NULL;

-- 3. O dossiê aponta para os DOIS cards --------------------------------------
-- conversation_insights.deal_id (051) é UMA coluna. Um cliente com máquina na
-- bancada E negociando um notebook não cabe nela.

ALTER TABLE conversation_insights ADD COLUMN IF NOT EXISTS deal_servico_id UUID
  REFERENCES deals(id) ON DELETE SET NULL;

COMMENT ON COLUMN conversation_insights.deal_id IS
  'Negócio no funil de VENDAS. O de serviço vive em deal_servico_id (053).';

-- 4. Um funil de Serviço por conta que ainda não tem --------------------------
-- pipelines.user_id é NOT NULL: herda do funil mais antigo da conta.
-- Tem de vir por migration porque criar funil exige papel admin na RLS.

INSERT INTO pipelines (user_id, account_id, name, tipo)
SELECT p.user_id, p.account_id, 'Serviço', 'servico'
  FROM (SELECT DISTINCT ON (account_id) user_id, account_id
          FROM pipelines ORDER BY account_id, created_at) p
 WHERE NOT EXISTS (
   SELECT 1 FROM pipelines x
    WHERE x.account_id = p.account_id AND x.tipo = 'servico'
 );

-- 5. As seis colunas, em português e já mapeadas para a IA --------------------
-- "Máquina na loja" é o ganho: a máquina na bancada, não dinheiro. A IA está
-- proibida de colocar card lá (o código rebaixa para 'reservado') — quem
-- confirma que a máquina chegou é o sistema de OS ou o botão manual.

INSERT INTO pipeline_stages (pipeline_id, name, position, color, radar_stage)
SELECT p.id, v.nome, v.pos, v.cor, v.radar
  FROM pipelines p CROSS JOIN (VALUES
    ('Novo conserto',               0, '#3b82f6', 'novo'),
    ('Problema identificado',       1, '#eab308', 'qualificado'),
    ('Valor passado',               2, '#f97316', 'negociando'),
    ('Vai trazer / vamos buscar',   3, '#a855f7', 'reservado'),
    ('Máquina na loja (OS aberta)', 4, '#22c55e', 'ganho'),
    ('Não veio',                    5, '#6b7280', 'perdido')
  ) AS v(nome, pos, cor, radar)
 WHERE p.tipo = 'servico'
   AND NOT EXISTS (
     SELECT 1 FROM pipeline_stages s
      WHERE s.pipeline_id = p.id AND s.radar_stage = v.radar
   );
