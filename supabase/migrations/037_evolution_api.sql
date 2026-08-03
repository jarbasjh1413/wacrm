-- ============================================================
-- 037_evolution_api.sql
--
-- Evolution API engine (unofficial WhatsApp via Baileys) and
-- multi-number support (CLAUDE.md §6.3).
--
-- whatsapp_config becomes "one row per connected number/instance":
--   1. Drop UNIQUE(account_id) (added in 017) — an account may now
--      own several rows, one per WhatsApp number.
--   2. New columns for the Evolution engine. `engine` discriminates
--      row shape: 'meta' rows keep using phone_number_id +
--      access_token; 'evolution' rows use evolution_* columns.
--   3. phone_number_id / access_token relax to NULLable — they are
--      Meta-only concepts and Evolution rows don't have them.
--   4. Exactly one default row per account (partial unique index);
--      send paths fall back to it when a conversation has no pinned
--      instance.
--   5. conversations.whatsapp_config_id pins a thread to the number
--      it happened on, so replies leave from the same number.
--
-- Idempotent: guarded ALTERs, IF NOT EXISTS everywhere.
-- ============================================================

-- 1. One row per instance: drop the one-per-account constraint.
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;
CREATE INDEX IF NOT EXISTS idx_whatsapp_config_account_id
  ON whatsapp_config(account_id);

-- 2. Engine discriminator + Evolution columns.
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS engine TEXT NOT NULL DEFAULT 'meta';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_config_engine_check'
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_engine_check
      CHECK (engine IN ('meta', 'evolution'));
  END IF;
END $$;

ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS evolution_base_url TEXT;
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS evolution_instance_name TEXT;
-- Encrypted with AES-256-GCM via src/lib/whatsapp/encryption.ts,
-- same treatment as access_token.
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS evolution_apikey TEXT;
-- Human label shown in Settings ("Loja Canoas", "Loja Sapucaia"...).
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS display_name TEXT;
-- The connected number's phone (digits, country code included),
-- learned from the instance's ownerJid after QR pairing.
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS phone_number TEXT;
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

-- Instance names are globally unique on an Evolution server; enforce
-- uniqueness so webhook routing (instance -> account) is unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_instance_name_key
  ON whatsapp_config(evolution_instance_name)
  WHERE evolution_instance_name IS NOT NULL;

-- 3. Meta-only columns relax to NULLable for Evolution rows.
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config ALTER COLUMN access_token DROP NOT NULL;

-- 4. Exactly one default per account. Existing rows (previously the
-- only row of their account) become the default.
UPDATE whatsapp_config wc
SET is_default = true
WHERE NOT EXISTS (
  SELECT 1 FROM whatsapp_config d
  WHERE d.account_id = wc.account_id AND d.is_default
)
AND wc.id = (
  SELECT x.id FROM whatsapp_config x
  WHERE x.account_id = wc.account_id
  ORDER BY x.created_at ASC
  LIMIT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_account_default_key
  ON whatsapp_config(account_id)
  WHERE is_default;

-- 5. Pin conversations to the instance they happened on. NULL means
-- "use the account default" (all pre-Evolution rows).
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_config
  ON conversations(whatsapp_config_id)
  WHERE whatsapp_config_id IS NOT NULL;

-- RLS: whatsapp_config and conversations already have RLS enabled with
-- account-membership policies (017); new columns inherit them. No new
-- tables, no new policies needed.
