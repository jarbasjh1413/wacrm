-- 052: o funil falando português e com os momentos que o Jarbas usa
--
-- A 051 ligou o Radar ao funil, mas o funil real ainda era o template
-- em inglês (New Lead / Qualified / Proposal Sent / Negotiation / Won).
-- Faltavam justamente dois momentos que ele citou: "quando ele já
-- reservou" e "quando perdeu".
--
-- Só mexe em estágio que ainda está com o nome exato do template — se
-- alguém já renomeou na mão, fica como está.
--
-- Idempotente.

-- 1. Nomes em pt-BR ---------------------------------------------------------

UPDATE pipeline_stages SET name = 'Novo lead'         WHERE name = 'New Lead';
UPDATE pipeline_stages SET name = 'Qualificado'       WHERE name = 'Qualified';
UPDATE pipeline_stages SET name = 'Orçamento enviado' WHERE name = 'Proposal Sent';
UPDATE pipeline_stages SET name = 'Negociando'        WHERE name = 'Negotiation';
-- 'Comprou' abre espaço na posição 4 para o 'Reservado'.
UPDATE pipeline_stages SET name = 'Comprou', position = 5 WHERE name = 'Won';

-- 2. Os dois momentos que faltavam ------------------------------------------

INSERT INTO pipeline_stages (pipeline_id, name, position, color, radar_stage)
SELECT p.id, 'Reservado', 4, '#f59e0b', 'reservado'
  FROM pipelines p
 WHERE NOT EXISTS (
   SELECT 1 FROM pipeline_stages s
    WHERE s.pipeline_id = p.id AND s.radar_stage = 'reservado'
 );

INSERT INTO pipeline_stages (pipeline_id, name, position, color, radar_stage)
SELECT p.id, 'Perdido', 6, '#6b7280', 'perdido'
  FROM pipelines p
 WHERE NOT EXISTS (
   SELECT 1 FROM pipeline_stages s
    WHERE s.pipeline_id = p.id AND s.radar_stage = 'perdido'
 );

-- 3. Reencaixa o vocabulário do Radar nos nomes novos ------------------------
-- (a 051 mapeou pelos nomes em inglês; isto garante o mesmo resultado
--  para quem rodar as duas migrations de uma vez.)

UPDATE pipeline_stages SET radar_stage = 'novo'        WHERE radar_stage IS NULL AND name = 'Novo lead';
UPDATE pipeline_stages SET radar_stage = 'qualificado' WHERE radar_stage IS NULL AND name = 'Qualificado';
UPDATE pipeline_stages SET radar_stage = 'negociando'  WHERE radar_stage IS NULL AND name IN ('Orçamento enviado', 'Negociando');
UPDATE pipeline_stages SET radar_stage = 'ganho'       WHERE radar_stage IS NULL AND name = 'Comprou';
