-- 054: modo ensaio + funis conforme a operação real (Jarbas, 08/08/2026)
--
-- Três pedidos dele numa migration só:
--
-- 1. "Não quero nada já cobrando clientes agora." Hoje os cenários
--    `equipamento_pronto` e `pos_venda` enviam SOZINHOS. Nasce o MODO
--    ENSAIO: o agente continua detectando, escrevendo e enfileirando —
--    mas não sai nada para o cliente. Ele vê tudo na fila e decide.
--
-- 2. "Conforme a OS é movimentada no nosso sistema, movimentar dentro do
--    funil aqui no CRM." O funil de serviço ganha as colunas dirigidas
--    pela OS. NÃO são as 12 do kanban dele — são as 4 que mudam o que o
--    CRM tem a DIZER ao cliente (na bancada / orçamento enviado / pronta
--    pra retirar / entregue). Quem move essas é o evento da OS, nunca a IA.
--
-- 3. "Entre o lead mandar mensagem e ser de fato um lead qualificado a
--    gente precisa qualificar ele." O funil de vendas ganha a coluna
--    "Qualificando" e o vocabulário da IA ganha duas palavras, o que de
--    quebra conserta um bug: "Orçamento enviado" e "Negociando" tinham a
--    MESMA palavra ('negociando'), então a IA nunca conseguia colocar um
--    card em "Negociando".
--
-- Idempotente. Nenhum negócio muda de coluna: as posições mudam, o
-- stage_id de cada card continua o mesmo.

-- 1. MODO ENSAIO --------------------------------------------------------

ALTER TABLE followup_settings
  ADD COLUMN IF NOT EXISTS modo_ensaio BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN followup_settings.modo_ensaio IS
  'Ligado: o agente detecta e enfileira, mas NÃO envia nada ao cliente. '
  'Tudo cai na fila de aprovação para a pessoa decidir.';

-- Liga para quem já existe: o pedido do dono foi explícito, e nenhuma
-- conta em operação hoje depende do envio automático.
UPDATE followup_settings SET modo_ensaio = TRUE WHERE modo_ensaio = FALSE;

-- 2. VOCABULÁRIO DA IA: duas palavras novas ------------------------------
-- 'qualificando' (ainda descobrindo se é lead de verdade) e 'orcamento'
-- (valor/proposta já apresentada) — que separa "Orçamento enviado" de
-- "Negociando" no funil de vendas.

DO $$
BEGIN
  ALTER TABLE pipeline_stages DROP CONSTRAINT IF EXISTS pipeline_stages_radar_stage_check;
  ALTER TABLE pipeline_stages ADD CONSTRAINT pipeline_stages_radar_stage_check
    CHECK (radar_stage IS NULL OR radar_stage IN (
      'novo', 'qualificando', 'qualificado', 'orcamento',
      'negociando', 'reservado', 'ganho', 'perdido'
    ));
END $$;

-- 3. COLUNAS DIRIGIDAS PELA ORDEM DE SERVIÇO -----------------------------
-- Um estágio pode ser movido pela IA (radar_stage) OU pela OS
-- (os_situacao). Nunca pelos dois: são motores separados, sem colisão.

ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS os_situacao TEXT;

DO $$
BEGIN
  ALTER TABLE pipeline_stages DROP CONSTRAINT IF EXISTS pipeline_stages_os_situacao_check;
  ALTER TABLE pipeline_stages ADD CONSTRAINT pipeline_stages_os_situacao_check
    CHECK (os_situacao IS NULL OR os_situacao IN (
      'aguardando_recebimento', 'na_bancada',
      'aguardando_cliente', 'pronto', 'finalizada'
    ));
END $$;

CREATE INDEX IF NOT EXISTS idx_pipeline_stages_os_situacao
  ON pipeline_stages(pipeline_id, os_situacao)
  WHERE os_situacao IS NOT NULL;

-- 4. FUNIL DE VENDAS: a etapa de qualificação ----------------------------
-- Abre espaço primeiro (de trás para frente, para não colidir posição).

UPDATE pipeline_stages s SET position = 7
  FROM pipelines p WHERE p.id = s.pipeline_id AND p.tipo = 'vendas'
   AND s.radar_stage = 'perdido';
UPDATE pipeline_stages s SET position = 6
  FROM pipelines p WHERE p.id = s.pipeline_id AND p.tipo = 'vendas'
   AND s.radar_stage = 'ganho';
UPDATE pipeline_stages s SET position = 5
  FROM pipelines p WHERE p.id = s.pipeline_id AND p.tipo = 'vendas'
   AND s.radar_stage = 'reservado';
UPDATE pipeline_stages s SET position = 4
  FROM pipelines p WHERE p.id = s.pipeline_id AND p.tipo = 'vendas'
   AND s.name = 'Negociando';
-- Aqui some a ambiguidade: "Orçamento enviado" passa a ter palavra própria.
UPDATE pipeline_stages s SET position = 3, radar_stage = 'orcamento'
  FROM pipelines p WHERE p.id = s.pipeline_id AND p.tipo = 'vendas'
   AND s.name = 'Orçamento enviado';
UPDATE pipeline_stages s SET position = 2
  FROM pipelines p WHERE p.id = s.pipeline_id AND p.tipo = 'vendas'
   AND s.radar_stage = 'qualificado';

INSERT INTO pipeline_stages (pipeline_id, name, position, color, radar_stage)
SELECT p.id, 'Qualificando', 1, '#94a3b8', 'qualificando'
  FROM pipelines p
 WHERE p.tipo = 'vendas'
   AND NOT EXISTS (SELECT 1 FROM pipeline_stages s
                    WHERE s.pipeline_id = p.id AND s.radar_stage = 'qualificando');

-- 5. FUNIL DE SERVIÇO: o que a OS movimenta ------------------------------
-- Antes: ... Vai trazer(3) → Máquina na loja(4, ganho) → Não veio(5).
-- Agora: a máquina entra e o card SEGUE a OS até a entrega.

UPDATE pipeline_stages s SET position = 8
  FROM pipelines p WHERE p.id = s.pipeline_id AND p.tipo = 'servico'
   AND s.radar_stage = 'perdido';

-- "Valor passado" ganha a palavra própria (era 'negociando').
UPDATE pipeline_stages s SET radar_stage = 'orcamento'
  FROM pipelines p WHERE p.id = s.pipeline_id AND p.tipo = 'servico'
   AND s.name = 'Valor passado';

-- "Vai trazer" é o teto da IA E o espelho de "OS aberta, máquina a caminho".
UPDATE pipeline_stages s SET os_situacao = 'aguardando_recebimento'
  FROM pipelines p WHERE p.id = s.pipeline_id AND p.tipo = 'servico'
   AND s.radar_stage = 'reservado';

-- A chegada deixa de ser o fim: vira a primeira coluna da OS. Perde o
-- 'ganho' (que passa a ser a entrega) e ganha o motor da OS.
UPDATE pipeline_stages s
   SET name = 'Máquina na loja', radar_stage = NULL, os_situacao = 'na_bancada'
  FROM pipelines p WHERE p.id = s.pipeline_id AND p.tipo = 'servico'
   AND s.position = 4 AND s.os_situacao IS NULL;

INSERT INTO pipeline_stages (pipeline_id, name, position, color, radar_stage, os_situacao)
SELECT p.id, v.nome, v.pos, v.cor, NULL, v.situacao
  FROM pipelines p CROSS JOIN (VALUES
    ('Orçamento enviado (OS)', 5, '#8b5cf6', 'aguardando_cliente'),
    ('Pronta pra retirar',     6, '#ef4444', 'pronto')
  ) AS v(nome, pos, cor, situacao)
 WHERE p.tipo = 'servico'
   AND NOT EXISTS (SELECT 1 FROM pipeline_stages s
                    WHERE s.pipeline_id = p.id AND s.os_situacao = v.situacao);

-- A entrega é o ganho de verdade do serviço.
INSERT INTO pipeline_stages (pipeline_id, name, position, color, radar_stage, os_situacao)
SELECT p.id, 'Entregue', 7, '#15803d', 'ganho', 'finalizada'
  FROM pipelines p
 WHERE p.tipo = 'servico'
   AND NOT EXISTS (SELECT 1 FROM pipeline_stages s
                    WHERE s.pipeline_id = p.id AND s.os_situacao = 'finalizada');
