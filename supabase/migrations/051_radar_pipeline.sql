-- 051: Radar alimenta o funil de vendas (pedido do Jarbas, 05/08/2026)
--
-- "A IA colocar no pipeline o valor que o cliente está disposto a
--  gastar, baseado no momento de compra — se está quente, frio, se já
--  está negociando valores, se reservou ou comprou."
--
-- O desenho evita o erro clássico de bagunçar o board de quem usa:
--   1. A IA fala num vocabulário CANÔNICO (novo/qualificado/negociando/
--      reservado/ganho/perdido), nunca nos nomes dos estágios do dono.
--   2. Cada estágio real recebe (opcionalmente) uma etiqueta canônica.
--      Sem mapeamento, o Radar **não move** nada — só cria o negócio no
--      primeiro estágio e mantém o VALOR em dia.
--   3. Humano é soberano: negócio mexido por gente sai do automático.
--
-- Idempotente.

-- 1. Vocabulário canônico nos estágios do dono ------------------------------

ALTER TABLE pipeline_stages
  ADD COLUMN IF NOT EXISTS radar_stage TEXT;

DO $$
BEGIN
  ALTER TABLE pipeline_stages DROP CONSTRAINT IF EXISTS pipeline_stages_radar_stage_check;
  ALTER TABLE pipeline_stages ADD CONSTRAINT pipeline_stages_radar_stage_check
    CHECK (radar_stage IS NULL OR radar_stage IN (
      'novo', 'qualificado', 'negociando', 'reservado', 'ganho', 'perdido'
    ));
END $$;

CREATE INDEX IF NOT EXISTS idx_pipeline_stages_radar
  ON pipeline_stages(pipeline_id, radar_stage)
  WHERE radar_stage IS NOT NULL;

-- Palpite inicial pelos nomes que já existem (template em inglês e os
-- termos que a Oficina usa). O dono ajusta na tela quando quiser.
UPDATE pipeline_stages SET radar_stage = 'novo'
 WHERE radar_stage IS NULL
   AND (name ILIKE '%new lead%' OR name ILIKE '%novo%' OR name ILIKE '%qualificar%');
UPDATE pipeline_stages SET radar_stage = 'qualificado'
 WHERE radar_stage IS NULL
   AND (name ILIKE '%qualified%' OR name ILIKE '%qualificado%');
UPDATE pipeline_stages SET radar_stage = 'negociando'
 WHERE radar_stage IS NULL
   AND (name ILIKE '%negotiat%' OR name ILIKE '%negocia%'
        OR name ILIKE '%proposal%' OR name ILIKE '%orçamento%' OR name ILIKE '%orcamento%');
UPDATE pipeline_stages SET radar_stage = 'reservado'
 WHERE radar_stage IS NULL
   AND (name ILIKE '%reserv%' OR name ILIKE '%aparta%');
UPDATE pipeline_stages SET radar_stage = 'ganho'
 WHERE radar_stage IS NULL
   AND (name ILIKE '%won%' OR name ILIKE '%ganho%'
        OR name ILIKE '%pago%' OR name ILIKE '%comprou%' OR name ILIKE '%fechado%');
UPDATE pipeline_stages SET radar_stage = 'perdido'
 WHERE radar_stage IS NULL
   AND (name ILIKE '%lost%' OR name ILIKE '%perdido%');

-- 2. O que o Radar aprendeu sobre dinheiro ----------------------------------

ALTER TABLE conversation_insights
  ADD COLUMN IF NOT EXISTS valor_estimado NUMERIC(12, 2);
-- Como a IA chegou nesse número ("disse que pode pagar até 4.500").
ALTER TABLE conversation_insights
  ADD COLUMN IF NOT EXISTS valor_origem TEXT;
-- Negócio que o Radar mantém para esta conversa.
ALTER TABLE conversation_insights
  ADD COLUMN IF NOT EXISTS deal_id UUID REFERENCES deals(id) ON DELETE SET NULL;

-- 3. Soberania humana no negócio --------------------------------------------
-- Mexeu no valor ou arrastou o card? O Radar para de mexer naquilo.

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS created_by_radar BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS value_locked_at TIMESTAMPTZ;
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS stage_locked_at TIMESTAMPTZ;
