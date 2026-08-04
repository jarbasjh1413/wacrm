-- 042: tipo 'system_alert' em notifications
--
-- Suporte a alertas de sistema no sino de notificações — o primeiro
-- uso é o detector de conexão travada da Evolution (socket zumbi:
-- envios falham com "Connection Closed" enquanto o estado diz open;
-- incidente de 03-04/08/2026). conversation_id/contact_id já são
-- opcionais, então só o CHECK de type precisa crescer. Idempotente.

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'system_alert'));
