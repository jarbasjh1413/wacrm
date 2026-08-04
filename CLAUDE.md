# CLAUDE.md — CRM Oficina Informática (fork do wacrm)

## 0. Como trabalhar comigo (LEIA PRIMEIRO)

Eu (Jarbas) sou o dono do negócio. **Não sou desenvolvedor** — entendo os conceitos,
mas quero construir isso JUNTO, aprendendo no caminho. Regras para você, Claude Code:

1. **Explique antes de fazer.** A cada etapa, diga em português simples: o que vamos
   fazer, por que, e o que vai mudar no sistema. Só depois execute.
2. **Passos pequenos e verificáveis.** Nunca faça 10 coisas de uma vez. Faça uma,
   me mostre como testar (ex.: "abre localhost:3000/inbox e manda uma mensagem de
   teste pro número X"), espere eu confirmar, e siga.
3. **Todo fim de sessão**, resuma: o que foi feito, o que falta, e qual o próximo
   passo. Atualize a seção 13 (Diário de bordo) deste arquivo.
4. **Me ensine o vocabulário.** Quando usar um termo técnico (migration, webhook,
   RLS, env var), explique em uma frase na primeira vez.
5. **Nunca rode nada destrutivo** (apagar tabela, resetar banco, forçar deploy)
   sem me avisar e pedir confirmação explícita.
6. **Se algo der errado**, explique o erro em linguagem simples antes de sair
   corrigindo.
7. Sempre em **português brasileiro**.

---

## 1. Contexto do projeto

Fork do template **wacrm** (github.com/ArnasDon/wacrm, licença MIT) — CRM
auto-hospedável para WhatsApp — adaptado para a **Oficina Informática**: loja de
manutenção e venda de notebooks e eletrônicos com mais de uma unidade, na região
de Canoas/Sapucaia do Sul (RS).

**Objetivos:**
1. Substituir por completo o CRM atual (crm-oficina-beta, na Vercel).
2. Trocar o motor de WhatsApp da Meta Cloud API (oficial) pela **Evolution API**
   (não oficial, conexão via QR code) — sem templates aprovados, sem custo por conversa.
3. Substituir a extensão **WA Scale** que uso hoje no Chrome: preciso de
   **agendamento de mensagens** e **scripts de mensagens** (um clique dispara uma
   sequência — ex.: script "Garantia" envia um vídeo + 2 mensagens de texto).
4. Integrar com o **sistema de ordens de serviço** já existente (projeto separado:
   Next.js 14 + TypeScript + PostgreSQL/Prisma) — **bancos separados, comunicação via API**.
5. Construir um **agente de IA de follow-up** — a funcionalidade mais importante.
   Dor real: hoje faço follow-up manual todos os dias e sei que muita coisa passa.

**Usuários:** eu + 2–3 pessoas da equipe. O template já tem multiusuário com
convites e papéis (`accounts`, `account_invitations`, migrations 017–020) — usar isso.

**Números de WhatsApp:** quantidade ainda não definida. A arquitetura DEVE
suportar múltiplos números/instâncias desde o início.

---

## 2. Decisões fechadas (não rediscutir)

| Decisão | Escolha |
|---|---|
| Base de código | Fork do wacrm (branch main) |
| API de WhatsApp | Evolution API (Baileys) — NÃO usar Meta Cloud API |
| CRM atual (crm-oficina-beta) | Será desligado; este o substitui |
| Integração com sistema de OS | Bancos separados + API REST entre eles |
| Agente de follow-up | Híbrido: automático nos casos simples, fila de aprovação nos delicados |
| Cenários de follow-up | Orçamento sem resposta, equipamento pronto não retirado, pós-venda, lead frio |
| Scripts e agendamento | Funcionalidade obrigatória (substitui a WA Scale) |
| Evolution API hospedada em | VPS Hostinger, template Docker 1-clique "Evolution API" (já inclui PostgreSQL + Redis próprios) |
| Banco/Auth do CRM | Supabase (Postgres + RLS + Auth + Realtime), como no template |

**Em aberto:** quantos números de WhatsApp (um geral ou um por unidade);
hospedagem do app Next.js (Vercel vs Hostinger); nome/domínio final.

---

## 3. Stack e infraestrutura (o "mapa geral")

- **App:** Next.js 16 (App Router), React 19, TypeScript, Tailwind v4, shadcn/base-ui.
- **Banco e login:** Supabase — Postgres com RLS (segurança linha a linha) em toda
  tabela, Auth por e-mail/senha, Storage para arquivos, Realtime para o inbox ao vivo.
  Sem ORM: as rotas do servidor leem/escrevem no Supabase via `@supabase/ssr`.
- **WhatsApp:** Evolution API num VPS da Hostinger (Docker). Cada número é uma
  "instância" conectada por QR code. A Evolution avisa o app via webhooks
  (chamadas HTTP) a cada mensagem recebida.
- **IA:** API da Anthropic (Claude). O template JÁ TEM um módulo de IA
  (`src/app/api/ai/*`, migrations 029–033: `ai_reply`, `ai_knowledge`) —
  o agente de follow-up ESTENDE esse módulo, não cria um paralelo.
- **Criptografia:** AES-256-GCM já pronta em `src/lib/whatsapp/encryption.ts` —
  reutilizar para a apikey da Evolution.

---

## 4. O que o template já traz pronto (não reconstruir)

Inbox compartilhado em tempo real; contatos + tags + campos customizados + notas;
pipelines Kanban com negócios (deals); broadcasts; automações no-code com cron;
flows visuais; dashboard; **quick replies** (respostas rápidas — base dos nossos
scripts); notificações; multiusuário com papéis; **API pública REST**
(`src/app/api/v1/`) com chaves em `api_keys` (migration 026) e webhooks de saída
em `webhook_endpoints` (migration 028) — a porta da integração com o sistema de OS.

Arquivos-chave do motor Meta a substituir: `src/lib/whatsapp/` (meta-api.ts,
send-message.ts, webhook-signature.ts, template-*.ts, broadcast-core.ts,
phone-utils.ts, resolve-conversation.ts) e as rotas em `src/app/api/whatsapp/`.

Migrations: `supabase/migrations/NNN_nome.sql`, idempotentes, em ordem. Tabelas
centrais: contacts, conversations, messages, deals, pipelines, broadcasts,
automations, flows, accounts, api_keys, webhook_endpoints, quick_replies, notifications.

---

## 5. FASE 0 — Fundação (fazer comigo, passo a passo)

Objetivo: sair do zero até o template rodando no meu computador, intocado.

1. Fork do repo no GitHub + clone local. Explicar a estrutura de pastas em 5 minutos.
2. Criar o projeto no Supabase e rodar TODAS as migrations na ordem. Explicar o que
   é uma migration e mostrar as tabelas criadas no painel do Supabase.
3. Configurar `.env.local` a partir do `.env.local.example` (explicar cada variável).
4. `npm install` e `npm run dev` — ver o template funcionando em localhost:3000,
   criar minha conta e passear pelas telas.
5. Contratar o VPS Hostinger com o template "Evolution API" e deixá-la no ar
   (guardar URL e apikey global).

**Checkpoint:** template original rodando + Evolution API respondendo no navegador.

---

## 6. FASE 1 — Trocar o motor: Meta → Evolution API

1. Criar `src/lib/whatsapp/evolution-api.ts` espelhando o contrato de `meta-api.ts`
   (envio de texto, mídia, reação) — assim o resto do app quase não muda.
2. Webhook novo: `POST /api/whatsapp/evolution/webhook` recebendo eventos da
   Evolution (`messages.upsert`, `messages.update`, `connection.update`,
   `qrcode.updated`). Fluxo: achar/criar contato pelo telefone → achar/criar
   conversa → gravar mensagem → disparar `runAutomationsForTrigger(...)`.
   Proteger com secret no header (a Evolution permite configurar headers).
3. Migration nova em `whatsapp_config`: campos `evolution_base_url`,
   `evolution_instance_name`, `evolution_apikey` (criptografada). **Uma linha por
   número/instância** (multi-número garantido).
4. Tela Settings → WhatsApp: criar instância → mostrar QR code → status da conexão.
5. Remover/ocultar tudo que é exclusivo da Meta: sync/submissão de templates,
   verificação de registro, assinatura HMAC da Meta. Broadcasts passam a usar
   mensagens livres com variáveis ({{nome}}, {{equipamento}}...).
6. Conferir `phone-utils.ts` para o padrão brasileiro: +55, DDD, nono dígito.

**Checkpoint:** conectar meu número de teste via QR code, receber uma mensagem no
inbox em tempo real e responder por ele.

---

## 7. FASE 2 — PT-BR e identidade

1. Avaliar o PR `feat/i18n-full` (next-intl, pt/es) do repo original; se inviável,
   traduzir todas as strings da UI para PT-BR.
2. Branding Oficina Informática: nome, logo, cores, favicon.
3. Remover a landing de marketing (`src/app/page.tsx` + `src/components/landing/*`);
   raiz redireciona para /login ou /dashboard.
4. Formatos: datas dd/mm/aaaa, moeda BRL (há `account_default_currency`, migration 021).

**Checkpoint:** minha equipe consegue usar sem esbarrar em inglês.

---

## 8. FASE 3 — Scripts de mensagens + agendamento (substituir a WA Scale)

O que eu faço hoje na WA Scale e preciso aqui dentro:

**Scripts (sequências com um clique):** ex.: na conversa, clico em "Garantia" e o
sistema envia, em ordem: o vídeo da garantia + 2 mensagens de texto. Sem redigitar nada.

1. Migrations novas (com RLS):
   - `message_scripts`: id, account_id, nome, descricao, criado_por.
   - `message_script_items`: script_id, ordem, tipo (`texto` | `midia`), conteudo,
     media_path (Supabase Storage), delay_segundos (pausa natural entre mensagens, ex.: 3–8s).
2. UI em Settings → Scripts: criar/editar scripts, subir mídias (vídeos, imagens,
   PDFs), ordenar itens, com suporte a variáveis ({{nome}}...).
3. No composer do inbox: botão "Scripts" ao lado das quick replies → um toque
   dispara a sequência completa na conversa aberta.

**Agendamento de mensagens:** escrever agora, enviar depois.

4. Migration `scheduled_messages`: id, account_id, conversation_id, contact_id,
   conteudo OU script_id, enviar_em (data/hora), status
   (`agendada` | `enviada` | `cancelada` | `falhou`), criado_por.
5. No composer: opção "Agendar" com data/hora. Página/listagem de agendadas com
   opção de cancelar.
6. Cron `GET /api/scheduled/cron` (mesmo padrão de `/api/automations/cron`):
   despacha o que venceu, respeitando as regras anti-ban da seção 11.

**Checkpoint:** criar o script "Garantia" com um vídeo real + 2 textos, disparar
numa conversa de teste, e agendar uma mensagem pra daqui a 10 minutos e vê-la sair.

---

## 9. FASE 4 — Integração com o sistema de OS

Bancos separados; comunicação via API REST autenticada usando a infra existente
(`api_keys` para entrada, `webhook_endpoints` para saída).

**OS → CRM (eventos):** endpoint novo `POST /api/v1/os-events` (autenticado por
api_key). Payload:

```json
{
  "os_id": "1234",
  "evento": "status_alterado",
  "status": "pronto | orcamento_enviado | aguardando_aprovacao | entregue",
  "cliente": { "nome": "...", "telefone": "+55..." },
  "equipamento": "Notebook Dell Inspiron 15",
  "valor_orcamento": 450.00,
  "data_evento": "2026-07-30T14:00:00Z",
  "unidade": "canoas | sapucaia"
}
```

O CRM resolve o contato pelo telefone (cria se não existir), grava numa migration
nova `os_events` (com RLS) e alimenta automações e o agente de follow-up.

**CRM → OS (consulta):** na sidebar da conversa, mostrar as OSs do cliente
(status, equipamento, valores). O sistema de OS precisará expor
`GET /api/clientes/{telefone}/ordens` — **documentar esse contrato num arquivo
`docs/integracao-os.md` como entregável desta fase**, para implementarmos juntos
no outro projeto.

**Checkpoint:** mudar o status de uma OS de teste no outro sistema e ver o evento
aparecer no CRM; abrir a conversa do cliente e ver as OSs dele na lateral.

---

## 10. FASE 5 — Agente de IA de follow-up (coração do projeto)

### Princípio
Nenhuma conversa comercial morre no esquecimento. A máquina detecta, a IA
interpreta e redige; eu aprovo o que é delicado.

### Detecção (cron 2x ao dia, horário comercial)
Rota `GET /api/followups/cron` (protegida por secret). Varre conversas + os_events:

| Cenário | Gatilho | Modo |
|---|---|---|
| Equipamento pronto não retirado | os_events status=pronto há ≥ N dias | **Automático** |
| Pós-venda / satisfação | OS entregue há N dias | **Automático** |
| Orçamento sem resposta | orçamento enviado, última mensagem é nossa, sem resposta há ≥ N dias | **Fila de aprovação** |
| Lead frio no funil | deal parado em estágio ativo há ≥ N dias | **Fila de aprovação** |

Prazos (N) configuráveis em Settings. Máximo 1 follow-up pendente por conversa;
cadência mínima de 3 dias entre follow-ups ao mesmo contato; máximo de tentativas
por cenário (padrão 3 — depois arquivar com tag).

### Geração (Claude)
Contexto enviado: histórico recente da conversa + dados da OS/deal + cenário +
`ai_knowledge` (informações do negócio: serviços, prazos, políticas). O Claude
pode decidir **não enviar** (ex.: cliente já disse que vem amanhã). Mensagens em
PT-BR, tom informal-profissional, curtas, personalizadas, sem cara de robô.

### Fila de aprovação
Migration `followup_suggestions`: id, account_id, conversation_id, contact_id,
os_id?, deal_id?, cenario, mensagem_sugerida, justificativa_ia, status
(`pending` | `approved` | `edited` | `discarded` | `sent` | `auto_sent`),
mensagem_final, created_at, decided_at, decided_by.

Página `/followups`, **mobile-first** (vou aprovar pelo celular): cada sugestão
mostra o contexto da conversa e botões aprovar / editar e enviar / descartar.
Os automáticos ficam registrados como `auto_sent` num log visível.

### Aprendizado
Gravar sempre a diferença entre sugerida e final — alimenta ajustes de prompt e a
futura promoção de cenários de "aprovação" para "automático".

**Checkpoint:** simular um orçamento sem resposta e ver a sugestão certa aparecer
em /followups; aprovar e ver a mensagem sair.

---

## 11. Regras anti-ban (OBRIGATÓRIAS, valem para tudo)

Com API não oficial, o risco real é banimento do número. Valem para broadcasts,
follow-ups, scripts e agendamentos, sem exceção:

1. Delay aleatório entre envios em massa: 30–120 segundos.
2. Limite diário configurável de mensagens "frias" por número (padrão inicial: 50/dia).
3. Envios só em horário comercial (configurável; padrão 9h–18h, seg–sáb).
4. Warm-up: número recém-conectado opera com limites reduzidos por 2–3 semanas.
5. Opt-out: resposta negativa ("não quero receber", "para", "sair") aplica tag
   `nao-contatar` e suprime o contato de tudo que é automatizado.
6. Priorizar contatos que já conversaram com a loja.
7. Monitorar `connection.update` da Evolution e notificar se a instância cair.

---

## 12. Convenções + melhorias futuras

**Convenções:** migrations idempotentes `NNN_nome.sql` em ordem; RLS em TODA
tabela nova; tipos em `src/types/*`; rotas novas seguindo o padrão existente;
TypeScript estrito com typecheck + build ao fim de cada fase; segredos só em env
vars ou criptografados no banco; manter o rate limiting (`src/lib/rate-limit.ts`).
Env vars novas: `EVOLUTION_BASE_URL`, `EVOLUTION_GLOBAL_APIKEY`,
`EVOLUTION_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `FOLLOWUP_CRON_SECRET`.

**Roadmap pós-MVP (não fazer agora, não esquecer):**
- Broadcasts "inteligentes" (ideia do Jarbas, 31/07/2026): reforma para mensagens
  livres + variáveis fica para o futuro; quando vier, incluir (a) tag automática
  em quem recebeu o disparo (a tabela broadcast_recipients já registra
  enviado/entregue/lido/respondeu por pessoa), (b) cenário de follow-up
  "recebeu broadcast e não respondeu há N dias" no agente da Fase 5,
  (c) relatórios de taxa de resposta por disparo.
- Promover cenários de follow-up de "aprovação" para "automático" conforme acerto.
- Agente de IA respondendo dúvidas comuns direto no inbox (estender `ai/autoreply`).
- Relatórios: taxa de resposta a follow-ups, receita recuperada, scripts mais usados.
- Multi-unidade completa: número, equipe e relatórios por unidade.
- Pesquisa de satisfação com nota (NPS) e alerta de nota baixa.
- Migração dos dados úteis do crm-oficina-beta antes de desligá-lo.

---

## 13. Diário de bordo (Claude Code: atualize a cada sessão)

| Data | O que foi feito | Próximo passo |
|---|---|---|
| — | Projeto ainda não iniciado | Fase 0, item 1 |
| 31/07/2026 | Fase 0 iniciada: fork já existia (jarbasjh1413/wacrm), clone feito em `Projetos\crm-oficina`, CLAUDE.md instalado na raiz, `npm install` rodado, `.env.local` criado com ENCRYPTION_KEY gerada (faltam as chaves do Supabase). Supabase CLI instalado mas sem login. | Jarbas: criar projeto no Supabase (ou `supabase login`) e colar URL + anon key + service role key no `.env.local`. Depois: rodar as 36 migrations e `npm run dev`. |
| 31/07/2026 | Fase 0 quase completa: projeto Supabase `crm-oficina-on` criado (São Paulo, ref weqpablulfoltlicoeij), CLI logado e linkado, as 36 migrations aplicadas com sucesso (36 tabelas no schema public), `.env.local` completo (URL, publishable key, service_role, ENCRYPTION_KEY). Obs.: foi preciso `ALTER DATABASE postgres SET search_path TO "$user", public, extensions` para o `db push` enxergar uuid_generate_v4(). `npm run dev` rodando, tela de login OK em localhost:3000. | Jarbas: criar conta em localhost:3000/signup e passear pelas telas. Depois: item 5 da Fase 0 (VPS Hostinger + Evolution API). |
| 31/07/2026 | Jarbas criou a conta e navegou pelo dashboard — tudo funcionando. Feedback dele: visual "muito roxo e preto", quer identidade Oficina Informática (fica para a Fase 2 — pedir logo + cores da marca). | Item 5 da Fase 0: Jarbas contratar VPS Hostinger (template "Evolution API") e passar URL + apikey global. Aí começa a Fase 1. |
| 31/07/2026 | **FASE 0 COMPLETA** ✅ VPS Hostinger KVM 2 contratado (São Paulo), template Evolution API v2.3.7 no ar em `http://evolution-api-x49e.srv1870897.hstgr.cloud` (VPS srv1870897, painel Docker: evolution + traefik). Apikey global testada com sucesso (`/instance/fetchInstances` → 0 instâncias). URL e apikey salvas no `.env.local`. Pendência de segurança: API está em HTTP puro — configurar `evolution.oficinainformatica.tech` + HTTPS no início da Fase 1 (domínio já é da Hostinger). | Fase 1, item 1: criar `src/lib/whatsapp/evolution-api.ts` espelhando `meta-api.ts`. Antes: apontar subdomínio + HTTPS para a Evolution. |
| 31/07/2026 | Fase 1 avançou forte: (a) HTTPS ok no endereço do projeto (`https://evolution-api-x49e.srv1870897.hstgr.cloud`) — DNS `evolution.oficinainformatica.tech` criado para uso futuro; (b) `evolution-api.ts` pronto (14 funções, contrato espelhando meta-api); (c) migration **037** aplicada: multi-instância em `whatsapp_config` (engine meta/evolution, campos evolution_*, is_default, phone_number; `conversations.whatsapp_config_id`); (d) webhook `POST /api/whatsapp/evolution/webhook` (secret no header `x-evolution-secret`, trata messages.upsert/update, connection.update; grava mensagem, contato, conversa, dispara automações e webhooks de saída; fromMe vira mensagem de agente); (e) rotas `GET/POST /api/whatsapp/evolution/instances` e `GET/DELETE /instances/[id]` (criar instância + QR + status + remover). Tudo typecheck/lint/smoke-test ok. | Próximo: tela Settings → WhatsApp (QR code), túnel p/ webhook em dev (Evolution não alcança localhost), trocar o send-path (`send-message.ts`) p/ engine evolution, mídia recebida → Storage. Checkpoint: conectar número real. |
| 31/07/2026 | **CHECKPOINT FASE 1 BATIDO** ✅🎉 Tela Settings→WhatsApp pronta (instâncias + QR + status + remoção; substituiu a config Meta). Traduções `Settings.evolution` + fix do namespace `roles` que faltava no template (causa do "1 Issue"). Send-path por engine em `send-message.ts` (escolhe instância: pinada→default→primeira; templates bloqueados na evolution; conversa é "pinada" no 1º envio). Túnel cloudflared dev (`EVOLUTION_WEBHOOK_BASE_URL`) + webhook da instância reapontado. Build de produção OK. **Teste real do Jarbas: número `+555182306274` ("Jarbas teste") conectado via QR; msg inbound "testar CRM" apareceu em tempo real no inbox; resposta "óleo" entregue com tiques.** | Restos da Fase 1: mídia recebida → bucket chat-media (áudio/foto hoje só mostram placeholder); nono dígito BR em phone-utils; rota de reação p/ evolution; automations/flows/broadcasts ainda enviam via meta-send; ocultar UI de templates. Depois: Fase 2 (PT-BR + branding). |
| 31/07/2026 | Mídia recebida FUNCIONANDO (testada pelo Jarbas: foto renderiza, PDF abre; base64 do webhook ou `getBase64FromMediaMessage` → bucket `chat-media`, path `account-<id>/evolution/...`). Lightbox estilo WhatsApp no inbox (clicar amplia + botão download) — pedido do Jarbas, testado ✅. Nono dígito BR: `brazilNinthDigitVariant` + retry no envio quando a Evolution disser que o número não existe (`isNumberNotOnWhatsAppError`); 35 testes vitest passando. | Restos finais da Fase 1: reações enviadas pelo CRM em conversas evolution; automations/flows/broadcasts enviarem via engine (hoje meta-send direto); ocultar UI de templates Meta. Depois: Fase 2 (PT-BR + branding Oficina). |
| 31/07/2026 | Visual WhatsApp Web no inbox aprovado pelo Jarbas (tokens `wa-*`, balões verdes com orelha, badge/composer verdes, fundo bege/escuro; lição: mudanças de tema exigem limpar `.next` + restart). Criado `src/lib/whatsapp/engine-transport.ts` (loadSendConfig pinada→default→primeira + transportSend meta/evolution + isVariantRetryableError) e plugado em: automations/meta-send, flows/meta-send (texto, mídia, botões, listas — IA auto-reply usa o mesmo caminho) e rota de reação (`/api/whatsapp/react`, com fromMe). Templates na evolution → erro claro. Build de produção OK. | Testar: reação ❤️ pelo CRM chegar no celular; criar automação de teste e ver responder sozinha. Restam da Fase 1: broadcasts com mensagens livres + variáveis (substituem templates) e ocultar UI de templates Meta. Depois: Fase 2. |
| 31/07/2026 | Jarbas confirmou: sem API oficial → templates fora. Aba Templates removida do Settings (rail + overview; `?tab=templates` redireciona p/ whatsapp), verificado no navegador. Restam os botões de template no inbox/contatos (saem junto com a reforma dos broadcasts). | **Próxima sessão:** broadcasts com mensagens livres + variáveis {{nome}} (+ regras anti-ban §11: delay 30–120s, limite diário, horário comercial) e remover botões de template restantes. Depois: Fase 2 (PT-BR + branding). |
| 31/07/2026 | **FASE 2 INICIADA — sistema em PT-BR!** Jarbas adiou a reforma dos broadcasts (ideias de "disparos inteligentes" anotadas no roadmap). Colhido o `pt.json` do PR upstream #376 (branch local `i18n-pr-376`; PR completo conflita, só o arquivo de tradução foi aproveitado), completado com `roles` + `Settings.evolution` em PT e `Sidebar.title` = "Oficina Informática". `NEXT_PUBLIC_APP_LOCALE=pt` no .env.local. Verificado no navegador: UI nativa em português, zero MISSING_MESSAGE, `lang="pt"`. | Jarbas: passear pelas telas e anotar textos que sobraram em inglês (strings fixas em componentes que o PR #376 internacionalizou — portar essas partes aos poucos). Fase 2 restante: branding (logo/cores/favicon), remover landing, formatos dd/mm/aaaa. |
| 03/08/2026 | **Datas em pt-BR (dd/mm/aaaa) em todo o app.** Criado `src/lib/app-locale.ts` (INTL_LOCALE `pt-BR` + DATE_FNS_LOCALE `ptBR` derivados de `NEXT_PUBLIC_APP_LOCALE`, helpers formatShortDate/MediumDate/MediumDateTime/FullDateTime) e plugado nos ~20 pontos que formatavam data: 3 com `'en-US'` fixo (contacts, notas do contato, deal-card), os com locale do navegador (settings, join, charts do dashboard) e os date-fns (formatDistanceToNow com "há 2 horas", separadores de dia do inbox via `PPP`, flows runs, ai-usage). "Remover landing" já estava feito (raiz redireciona p/ /dashboard). Bônus: consertados 4 testes que já falhavam antes — 2 de timezone em `date-utils.test.ts` (datas UTC vs. local em UTC-3) e 2 do mock de `whatsapp_config` em `send/route.test.ts` que não virou lista pós-037. Typecheck, lint, **657/657 testes** e build de produção OK. | Jarbas conferir as datas no navegador. Fase 2 restante: branding (logo/cores/favicon — **pedir logo + cores ao Jarbas**), portar strings inglesas fixas restantes. Depois: reforma dos broadcasts (mensagens livres + {{nome}} + anti-ban §11). |
| 03/08/2026 | **BRANDING AZUL + i18n COMPLETO DAS TELAS** ✅ (a) Tema "oficina" (azul do logo: #0989cf→#137cc4→#3250a2, tokens oklch em globals.css + themes.ts) como padrão — violet e os demais seguem no seletor; favicon gradiente azul; logo real (public/brand/logo-oficina.png, de ~/Downloads) na sidebar e telas de auth em chip branco; título da aba "Oficina Informática"; gráficos seguem o accent (var(--chart-1)), Tremor violet→blue; menções "wacrm" visíveis rebrandadas em pt.json. (b) Merge do PR upstream #376 (buscado via `git fetch upstream pull/376/head`): signup, forgot-password, join, notifications, agents, dashboard-shell, inbox, settings, flows, broadcasts, interactive e ai-* agora 100% via t() — pt.json local já era superconjunto (0 chaves novas), en.json +257 chaves, es.json entrou junto. Conflitos resolvidos preservando logo + INTL_LOCALE. Verificado no navegador: login/signup/forgot em PT com logo, zero MISSING_MESSAGE. Typecheck/lint/657 testes/build OK. Commits: 06e475d (datas+branding), 5f4cbed (i18n). | **Backlog de strings em inglês na camada servidor** (varredura completa feita, ver §14): mensagens default de automações/flows enviadas ao cliente final via WhatsApp (src/lib/flows/templates.ts, src/lib/automations/templates.ts — PRIORIDADE, cliente vê), presence.ts ("N minutes ago"), feed do dashboard (queries.ts), nota de handoff da IA, erros de API comuns ('Unauthorized' etc.), notificação SQL (migration 027). Fase 2 restante: Jarbas conferir cores/tons do azul e telas. Depois: broadcasts inteligentes. |
| 03/08/2026 | **Janela de 24h removida para Evolution.** A trava "Sessão de 24 horas expirada — use um modelo" é regra da Meta Cloud API e não existe na Evolution. Agora o `message-thread` descobre o motor da conversa (instância pinada → padrão → primeira, espelhando o send-path; consulta client-side em `whatsapp_config`, RLS libera SELECT p/ membros) e só liga o timer/trava quando o motor é `meta`. Badge do timer some, compositor sempre habilitado. Tipo `Conversation` ganhou `whatsapp_config_id`. Sem trava no servidor (conferido). 657 testes OK. | Jarbas: recarregar o inbox e confirmar que dá pra digitar em conversas antigas. Próximo: P1 da §14 (templates de flows/automations em PT) ou broadcasts inteligentes. |
| 03/08/2026 | **Atalhos de ligação no topo da conversa.** Pedido do Jarbas (viu chamadas no WhatsApp Web). Explicado o limite: chamada de voz DENTRO do CRM é impossível via Evolution/Baileys (canal de voz é exclusivo dos apps oficiais). Solução: 2 botões no header do thread — glifo WhatsApp abre wa.me/<numero> (app oficial já na conversa, liga de lá com 1 clique) e ícone telefone `tel:+<numero>` (discador no celular). Chaves `Inbox.messageThread.callWhatsApp/callPhone` em pt/en/es. 657 testes OK. | Jarbas testar os 2 botões. Pendente da conversa: talvez trocar wa.me por web.whatsapp.com/send se ele preferir ir direto pro WhatsApp Web sem interstitial. |
| 03/08/2026 | **P1+P2 da §14: mensagens do servidor em pt-BR.** (a) P1 — templates de automações (`automations/templates.ts`) e de flows (`flows/templates.ts`) traduzidos E adaptados à Oficina (palavras-chave "preço/orçamento/valor", FAQ com horário/orçamento/garantia, captura de lead pergunta equipamento+problema em vez de e-mail corporativo/empresa). (b) P2 — presence.ts ("há 2 horas"), trigger-meta.ts (labels de gatilho + "há X min"), feed do dashboard (queries.ts), nota de handoff da IA (handoff.ts) — testes atualizados junto. (c) Migration **038** criada (trigger de notificação de atribuição em PT) mas **NÃO aplicada**: o supabase CLI não está logado neste Mac. 657 testes OK. | **Jarbas: rodar `npx supabase login` na pasta do projeto** (abre o navegador) e avisar — aí aplico a 038 com `db push`. Restam da §14 (P2/P3): erros de envio (send-message/broadcast-core/engine-transport), erros de rotas ('Unauthorized' etc.), template-status (UI Meta a ser removida), validações. Próximo grande: broadcasts inteligentes. |

---

## 14. Backlog: strings em inglês na camada servidor (varredura 03/08/2026)

A UI (componentes/páginas) está 100% i18n após o merge do PR #376. O que resta
está no servidor (`src/lib/`, `src/app/api/`) e chega ao usuário indiretamente.
Por prioridade:

**P1 — o CLIENTE FINAL vê no WhatsApp:**
- `src/lib/flows/templates.ts` — templates de flow inteiros ("Hi! 👋 Welcome to support...").
- `src/lib/automations/templates.ts` — defaults de automação ("Thanks for reaching out...").

**P2 — agentes veem na UI com frequência:**
- `src/lib/presence.ts` — chips "N minutes ago"/"a while ago".
- `src/lib/dashboard/queries.ts` — feed de atividade ("New message from...", "New contact:...").
- `src/lib/automations/trigger-meta.ts` — labels de gatilho ("New Message", "Keyword Match"...) e "h ago"/"d ago".
- `src/lib/ai/handoff.ts` — nota de handoff gravada no banco ("🤖 AI agent...").
- `src/lib/template-status.ts` — badges Draft/Pending/Approved/...
- `supabase/migrations/027_notifications.sql` — trigger grava title/body da notificação em inglês (precisa migration nova).
- `src/lib/whatsapp/send-message.ts` + `broadcast-core.ts` + `engine-transport.ts` — erros de envio ("WhatsApp not configured...").
- `src/app/api/ai/draft/route.ts` — erros do botão de rascunho IA.
- Erros genéricos repetidos nas rotas ('Unauthorized' ~30x, 'Your profile is not linked...').

**P3 — raros/aceitáveis em inglês:**
- Validações de flows/automations/templates/interactive; `src/lib/currency.ts` nomes de moedas;
  API pública v1 (dev-facing, pode ficar em inglês); `[Unsupported message]` no webhook evolution.

Estratégia sugerida: como são strings geradas no servidor (fora do next-intl de
client), criar um helper simples de dicionário pt no servidor ou mover a
formatação para o client onde couber. Decidir com o Jarbas caso a caso.
