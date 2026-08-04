-- 041: limite de mídia do chat de 16 MB → 50 MB
--
-- O teto de 16 MB era herança da Meta Cloud API (cap de vídeo dela).
-- No motor Evolution o limite prático é o do próprio WhatsApp (bem
-- maior) — o gargalo passa a ser o teto por arquivo do plano gratuito
-- do Supabase Storage: 50 MB. Pedido do Jarbas: vídeo "decente" no
-- script Garantia (03/08/2026).
--
-- Idempotente: só atualiza o file_size_limit do bucket existente.

UPDATE storage.buckets
SET file_size_limit = 52428800 -- 50 MB
WHERE id = 'chat-media';
