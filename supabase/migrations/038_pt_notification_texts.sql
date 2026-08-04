-- 038: textos de notificação em pt-BR
--
-- A migration 027 grava title/body das notificações de atribuição em
-- inglês ("New conversation assigned"). O app roda em pt-BR
-- (NEXT_PUBLIC_APP_LOCALE=pt), então o trigger passa a gravar os
-- textos em português. Idempotente: só redefine a função — o trigger
-- criado em 027 continua apontando para ela.

CREATE OR REPLACE FUNCTION notify_conversation_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_name TEXT;
  v_actor_name TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_agent_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.assigned_agent_id IS NULL
       OR NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Auto-atribuição não gera notificação.
  IF auth.uid() IS NOT NULL AND auth.uid() = NEW.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
  FROM contacts WHERE id = NEW.contact_id;

  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name
    FROM profiles WHERE user_id = auth.uid();
  END IF;

  INSERT INTO notifications (
    account_id, user_id, type, conversation_id, contact_id,
    actor_user_id, title, body
  ) VALUES (
    NEW.account_id,
    NEW.assigned_agent_id,
    'conversation_assigned',
    NEW.id,
    NEW.contact_id,
    auth.uid(),
    'Nova conversa atribuída a você',
    COALESCE(v_actor_name, 'Alguém') || ' atribuiu a você a conversa com '
      || COALESCE(v_contact_name, 'um contato')
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Falha na notificação nunca pode bloquear a atribuição em si.
  RAISE WARNING 'Failed to create assignment notification for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION notify_conversation_assigned() OWNER TO postgres;
