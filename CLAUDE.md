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

## 10.5 FASE 6 — Radar de Leads: IA que entende, agenda e escala (visão do Jarbas, 05/08/2026)

Referência visual: extensão que o Jarbas usa no WhatsApp Web (chips de funil com
contadores no topo: QUALIFICAR/FRIO/MORNO/QUENTE/RESERVOU...; painel lateral de
scripts por categoria). Nossa vantagem sobre ela: banco + IA — a extensão exige
classificação manual; aqui a IA classifica, agenda e escala sozinha.

**Ciclo (exemplo canônico do Jarbas):** cliente diz "vou comprar dia 20" → IA
grava o momento e AGENDA contato p/ dia 20 → agente chama no dia → 2 dias sem
resposta → novo toque → "só mês que vem" → IA reagenda p/ mês seguinte, morno →
nutrição contínua → "consegui um adiantamento, vou essa semana" → QUENTE 🔥 →
notifica + atribui a um humano imediatamente. Tudo acompanhável visualmente.

**Peças:**
1. Migration `conversation_insights`: conversation_id UNIQUE, temperatura
   (quente|morno|frio|indefinido), interesse, resumo, momentos JSONB
   [{em, tipo, texto}] (tipos: promessa_data, objecao, orcamento, interesse,
   pessoal), proximo_contato_em + motivo, escalado_em, ultima_analise_em.
2. Analisador IA (extensão do módulo ai/): dispara ~10 min após a última
   mensagem da conversa (fila no instrumentation, debounce; máx 1 análise/h
   por conversa). Critérios ENSINADOS pelo Jarbas em português (campos
   criterios_quente/morno/frio em followup_settings + tela de config).
   Saída JSON: temperatura, interesse, resumo, momentos novos,
   proximo_contato {quando, motivo} | null, escalar_humano bool + motivo.
3. Ações: upsert insights; tag de temperatura na conversa; proximo_contato →
   cenário novo 'promessa' no followup engine (dispara NA data, prioridade
   sobre os genéricos); escalar_humano → notificação + atribuição + QUENTE.
4. Retroalimentação: followup engine consome insights no prompt (contexto
   rico) e usa decisões humanas passadas (sent/edited/discarded de
   followup_suggestions) como exemplos de estilo.
5. Visual: (a) card Radar no topo da lateral da conversa (temperatura em cor,
   interesse, 3 momentos, próximo contato); (b) chips de funil com CONTADORES
   no topo do inbox (clique filtra — réplica da extensão); (c) página
   "Jornada": linha do tempo por lead + funil de conversão do período.
6. UX relacionada: painel lateral de scripts/respostas por CATEGORIA
   (ancorado, busca, 1 clique — réplica do painel direito da extensão;
   requer campo categoria em quick_replies/message_scripts).

**Checkpoint:** simular a jornada do exemplo canônico de ponta a ponta e
acompanhá-la na página Jornada.

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
- Menu de contexto completo do WhatsApp (print do Jarbas, 05/08/2026):
  já temos fixar, marcar não lida, fechar (≈arquivar), atribuir e apagar.
  Faltam: **silenciar notificações**, **adicionar aos favoritos**,
  **bloquear contato** e **limpar conversa** (apagar mensagens mantendo
  o contato). Silenciar e favoritos pedem coluna nova em conversations;
  bloquear pede tanto coluna quanto respeito no webhook de entrada.
- Reforma UX do inbox estilo WhatsApp (pedidos do Jarbas, 05/08/2026):
  (a) seleção múltipla de conversas com ações em massa — fechar, arquivar,
  excluir (arquivar exige coluna/estado novo em conversations); (b) filtros
  além de status — por canal de aquisição (WhatsApp, Instagram, site... exige
  campo `source` em contacts/conversations e captura na entrada de cada canal);
  (c) FEITO 05/08: microfone 1 clique no lugar do enviar quando o campo está
  vazio. Observação do Jarbas: virão leads de outros canais além do WhatsApp.
- Situações na Jornada além de quente/morno/frio (ideia do Jarbas,
  05/08/2026): "clientes que entraram em contato e não deram retorno",
  "clientes que querem marcar de vir na loja". Proposta: eixo SITUAÇÃO
  derivado (sem coluna nova, sem custo de IA) — aguardando_nossa_resposta
  (última msg é do cliente), sem_retorno (última msg é nossa há N dias),
  conversa_ativa (troca recente), agendado (tem proximo_contato_em) — mais
  os estágios que o Jarbas criar como etiquetas de funil (046). O Jarbas
  ainda vai definir a lista final que faz sentido na operação.
- **MULTICANAL** (direção do Jarbas, 05/08/2026): "pensar não só no WhatsApp,
  mas Instagram, Facebook — quando chegar um lead do Instagram, ter os mesmos
  comportamentos". Hoje TODO o modelo assume WhatsApp (contacts.phone é a
  chave, conversations.whatsapp_config_id, engine meta/evolution). Proposta de
  arquitetura: (1) `channels` (tipo instagram|facebook|whatsapp|site + credenciais)
  e `conversations.channel_id`; (2) `contact_identities` (contato ↔ identidade por
  canal: telefone, @usuario do IG, PSID do FB) — é o que permite UNIFICAR a
  pessoa que falou no IG e depois no WhatsApp, e "trazer o do Instagram pro
  WhatsApp"; (3) transporte por canal atrás da mesma interface do
  engine-transport; (4) o resto (Radar, follow-up, scripts, funil) já é
  agnóstico e passa a valer para todos os canais. Fazer DEPOIS da publicação.
- Fluxos de nutrição por situação (ideia do Jarbas, 05/08/2026): "sem retorno"
  e "retorno agendado" viram gatilhos de sequências de nutrição com contexto
  do lead — casa com o eixo SITUAÇÃO abaixo e com o agente de follow-up.
- Assistente de IA para criar automações (ideia do Jarbas, 05/08/2026): chat
  onde o usuário DESCREVE a automação em português ("quando chegar mensagem com
  'orçamento' fora do horário, responde X e me marca") e a IA monta a automação
  de verdade (Claude API + tool que escreve no schema de automations/flows).
  Estender o módulo de IA existente; fila de revisão antes de ativar.
- Importar histórico antigo do WhatsApp (pedido do Jarbas, 05/08/2026): exige
  religar a instância com syncFullHistory ativado (Evolution) + importador
  Evolution DB → CRM com dedupe por whatsapp_message_id. Detalhe: conferir
  settings de persistência da Evolution (hoje ela guarda pouco — findMessages
  do Eduardo retornou só 3 msgs).
- Ações CRM → OS na lateral da conversa (ideia do Jarbas, 05/08/2026): botão
  "Aprovar orçamento" (e afins) direto no card da OS — o CRM chama o sistema
  de OS, que muda o status e confirma de volta via os-events. Retroalimentação
  completa; requer endpoints de escrita no sistema de OS (expandir
  docs/integracao-os.md quando formos implementar).
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
| 03/08/2026 | **BROADCASTS INTELIGENTES IMPLEMENTADOS** 🚀 Reforma completa: (a) migration **039** (message_text, next_send_at, template_name nullable, tabela broadcast_limits com teto 50/dia + delay 30–120s + janela 9–18h seg–sáb + tz, RLS admin) — **PENDENTE de aplicar** junto com a 038 (supabase login travou: o CLI exige TTY, Jarbas precisa clicar Run e apertar Enter no terminal); (b) fila no servidor: broadcast-pacing.ts (funções puras testadas — janela/jitter/variáveis {{nome}}/{{primeiro_nome}}/{{telefone}}), broadcast-queue.ts (drena 1 destinatário por broadcast por tick, envia via engine-transport com retry de nono dígito, teto em janela 24h deslizante, finaliza sent/failed), instrumentation.ts (setInterval 15s no processo Next) + backstop GET /api/broadcasts/cron (x-cron-secret); (c) opt-out §11.5: broadcast-inbound.ts compartilhado (webhook evolution marca replied, "parar/sair/nao quero" → tag nao-contatar criada on-the-fly, fila pula contatos com a tag); webhook evolution também espelha ACKs em broadcast_recipients; (d) wizard novo de 3 passos (Mensagem com preview em balão WA → Público → Revisar com agendamento datetime + aviso anti-ban), hook createQueuedBroadcast (sem loop no navegador — pode fechar a aba); (e) templates Meta REMOVIDOS da UI: botão do composer, picker do inbox/contatos, passo send_template das automações, arquivos step1-choose-template/step3-personalize/step4-schedule-send/template-picker/template-manager deletados. i18n pt/en/es. Typecheck/lint/**670 testes**/build OK. | **1)** Jarbas: login supabase (Run + Enter no terminal) → aplicar migrations 038+039. **2)** Reiniciar `npm run dev` (ativa a fila do instrumentation). **3)** Testar: criar disparo pequeno p/ 2-3 contatos e ver sair com intervalo; responder "parar" e conferir a tag. Roadmap §12 continua: tag automática em quem recebeu, relatórios. |
| 03/08/2026 | **FASE 3 IMPLEMENTADA: scripts + agendamento (adeus WA Scale)** 🎬 (a) Migrations 038+039+040 APLICADAS no Supabase (login resolvido: era um Enter preso no terminal). (b) Migration 040: message_scripts + message_script_items (ordem, tipo texto/imagem/vídeo/documento/áudio, delay_seconds 0–300, mídia no bucket chat-media) e scheduled_messages (texto OU script, send_at, status agendada/enviada/cancelada/falhou), RLS agent+. (c) Motor: script-runner.ts roda a sequência na conversa via sendMessageToConversation (mesmo caminho do inbox — aparece no thread em tempo real; pausa natural entre itens; variáveis {{nome}}; para no 1º erro), scheduled-queue.ts drena vencidas com claim otimista, rota POST /api/scripts/[id]/run (maxDuration 120s), backstop GET /api/scheduled/cron, tick único no instrumentation p/ as 2 filas. Agendada respeita o horário escolhido pelo humano (§11 é p/ massa). (d) UI: Settings → Scripts (CRUD completo, itens ordenáveis c/ setas, upload de mídia, pausa por item), menu + do composer ganhou "Scripts" (1 toque dispara) e "Agendar mensagem" (datetime), página /scheduled na sidebar (Agendadas) com cancelar. i18n pt/en/es. 670 testes/lint/build OK. | **Checkpoint do Jarbas:** criar o script "Garantia" real (Settings → Scripts: vídeo + 2 textos), disparar numa conversa de teste e ver a sequência pingando; agendar uma mensagem p/ daqui a 10 min e vê-la sair sozinha; cancelar uma agendada. Depois: Fase 4 (integração OS) ou Fase 5 (agente IA de follow-up — o coração). |
| 03/08/2026 | **Limite de mídia 16 MB → 50 MB.** Jarbas bateu no teto ao subir o vídeo da Garantia. O cap de 16 MB era da Meta Cloud API; na Evolution o teto real é o do plano gratuito do Supabase Storage (50 MB/arquivo). Migration **041** (file_size_limit do bucket chat-media) APLICADA + MEDIA_MAX_BYTES_BY_KIND (vídeo/documento 50 MB, imagem 8 MB, áudio segue 16 MB) + testes. Vale para scripts, composer do inbox e flows. | Jarbas: subir o vídeo da Garantia de novo. Se algum dia precisar de >50 MB: upgrade do Supabase (Pro sobe o teto por arquivo) ou comprimir o vídeo. |
| 03/08/2026 | **Socket zumbi na Evolution (diagnóstico + remédio).** Teste do script "Catalogo" falhou com "Evolution API error: Connection Closed" em todos os envios, mas `connectionState` dizia `open` — sessão Baileys estava zumbi. Remédio final (04/08): restart/logout via API da Evolution TAMBÉM falhavam ("Connection Closed" até no logout) — o processo estava travado por inteiro. Resolvido reiniciando o PROJETO Docker evolution-api-x49e pelo Gerenciador Docker do hPanel (Claude pilotou o Chrome do Jarbas). Reconectou sozinho sem QR; teste real de sendText OK. **CHECKPOINT FASE 3 VALIDADO pelo Jarbas (04/08): script "Catalogo" (imagem + texto) disparado com 1 toque e entregue em sequência no WhatsApp real** ✅🎬 | **Backlog (anotar p/ implementar):** detecção automática de socket zumbi — N falhas "Connection Closed" seguidas num intervalo → o CRM não consegue reiniciar o container sozinho (é nível VPS), então: notificação urgente no CRM + instrução de reiniciar o projeto Docker no hPanel (§11.7 hoje só cobre connection.update, que não dispara nesse cenário). Jarbas: redisparar o script Catalogo p/ confirmar. |
| 04/08/2026 | **Detector de conexão travada IMPLEMENTADO** ⚠️ Gancho central em `evolutionFetch` (evolution-api.ts): todo envio `/message/*` reporta resultado a `connection-health.ts`. 3 falhas "Connection Closed" em 10 min → (a) `whatsapp_config.status=disconnected` (Settings mostra a verdade), (b) notificação `system_alert` no sino p/ owner+admins com o passo a passo do restart no hPanel (cooldown 30 min). Envio OK zera o contador e restaura o status. Migration **042** (tipo system_alert em notifications) APLICADA; tipo TS + ícone TriangleAlert na página de notificações. 671 testes/lint OK. | Se o travamento acontecer de novo: em ~1 min de tentativas de envio o sino acende com a instrução — reiniciar o projeto Docker evolution-api no hPanel (ou pedir pro Claude fazer via Chrome). Próximo: Fase 4 (integração OS). |
| 04/08/2026 | **FASE 4 IMPLEMENTADA (lado CRM): integração com o sistema de OS** 🔧 (a) Migration **043** APLICADA: os_events (histórico por evento; estado atual = evento mais recente por os_id; sem CHECK em status p/ vocabulário livre do sistema de OS; índices p/ lateral, dedupe e varredura da Fase 5; RLS leitura membros, escrita só service role). (b) POST /api/v1/os-events no padrão v1 (novo escopo **os:write**; find-or-create de contato pelo telefone reusa a lib de contatos; payload bruto guardado em jsonb). Smoke-test: 401 sem chave OK. (c) Lateral da conversa: seção "Ordens de serviço" (Wrench) entre Negócios e Notas — equipamento, badge de status colorido, OS nº/unidade, valor R$. (d) docs/integracao-os.md: contrato completo dos 2 sentidos (o GET /api/clientes/{telefone}/ordens fica p/ implementarmos no projeto do sistema de OS). Bônus: blindado resolveAuditUserId p/ contas multi-instância (.limit(1) — quebraria com 2º número). 671 testes/build OK. | **Checkpoint (metade Jarbas):** criar chave de API em Configurações → Chaves de API com escopo os:write, disparar o curl de exemplo do docs/integracao-os.md e ver a OS aparecer na lateral da conversa do contato. Depois: implementar o webhook no projeto do sistema de OS (usar o doc como guia) e a Fase 5 (agente de follow-up). |
| 05/08/2026 | **CHECKPOINT FASE 4 VALIDADO** ✅🔧 Claude executou o teste de ponta a ponta (chave temporária criada→evento disparado pela API v1→chave revogada; find-or-create de contato confirmado) e o Jarbas viu a seção "Ordens de serviço" na lateral da conversa (Notebook Dell · Pronto · OS TESTE-1234 · R$ 450 · canoas). Dados de teste limpos em seguida. Jarbas captou a visão e propôs a retroalimentação (aprovar orçamento pela lateral) — anotada no roadmap §12. | Próximos (escolha do Jarbas): Fase 5 (agente de follow-up) ou implementar o webhook no projeto do sistema de OS via docs/integracao-os.md. |
| 05/08/2026 | **Fotos de perfil do WhatsApp nos contatos** 📸 fetchProfilePictureUrl na evolution-api + avatar-sync.ts (URL do CDN expira → baixa os bytes → bucket chat-media `account-*/avatars/<contactId>.jpg` → contacts.avatar_url, que JÁ existia desde a 001) + gancho fire-and-forget no webhook (contato novo/sem foto) + header do thread renderizando (lista e lateral já renderizavam). Backfill executado: 7/7 contatos com foto. 671 testes OK. Jarbas também pediu: assistente de IA p/ criar automações conversando e histórico antigo do WhatsApp — ambos anotados no roadmap §12 com o caminho técnico. | Jarbas: F5 no inbox p/ ver as fotos. Escolher próximo: Fase 5 (agente follow-up), assistente de automações por IA, ou histórico completo (este exige re-parear o número com syncFullHistory). |
| 05/08/2026 | **Microfone 1 clique (estilo WhatsApp).** Campo vazio → botão redondo verde vira microfone (1 clique grava, usando o fluxo Ogg/Opus já existente); digitou → vira enviar. Antes a gravação ficava escondida no menu de anexos. Feedback UX do Jarbas anotado no roadmap §12: seleção múltipla c/ ações em massa (fechar/arquivar/excluir) e filtros por canal de aquisição (leads virão de outros canais além do WhatsApp). 671 testes OK. | Jarbas: F5 no inbox → conferir fotos de perfil + testar o microfone. Escolher a próxima frente: Fase 5, assistente de automações por IA, reforma UX do inbox (seleção múltipla/canais) ou histórico antigo. |
| 05/08/2026 | **FASE 5 IMPLEMENTADA: agente de IA de follow-up (o coração)** 🤖❤️ (a) Migration **044** APLICADA: followup_suggestions (cenário, sugerida/final, pending→sent/edited/auto_sent/discarded, decided_by; índice único = 1 pendente por conversa) + followup_settings (prazos N, cadência 3d, máx 3 tentativas, last_scan_at). (b) Motor followups/engine.ts: detecção dos 4 cenários (equipamento_pronto e pos_venda via os_events; orcamento_sem_resposta via os_events+última msg nossa; lead_frio via deals active parados), guardas §10/§11 (opt-out nao-contatar, cadência, tentativas), geração via módulo ai/ existente (loadAiConfig+generateReply+contexto+ai_knowledge; prompt PT-BR informal-profissional; IA PODE decidir não enviar; parser JSON defensivo), executor (automáticos→sendMessageToConversation+auto_sent; delicados→pending). (c) Relógio no instrumentation (checa 30/30min; ~2 varreduras/dia 9h-18h via last_scan_at) + backstop GET /api/followups/cron (FOLLOWUP_CRON_SECRET ou AUTOMATION_CRON_SECRET — este ADICIONADO ao .env.local, não existia). (d) Página /followups mobile-first (cards c/ foto, cenário, justificativa da IA, textarea editável, Aprovar e enviar / Descartar; log dos últimos incl. auto_sent) + POST /api/followups/[id]/decide (sent vs edited = aprendizado §10) + sidebar Handshake. (e) Teste: varredura rodou e parou certo em "sem IA configurada" — cenário TESTE-5001 (orçamento sem resposta, Eduardo, 4 dias) plantado esperando. 671 testes/lint OK. | **CHECKPOINT depende do Jarbas:** configurar a chave Anthropic em Agentes de IA → Setup; avisar o Claude → re-varredura → sugestão do Eduardo aparece em /followups → aprovar → mensagem sai. Com isso o ESQUELETO (Fases 0-5) fecha e começa o ciclo de melhorias (roadmap §12). |
| 05/08/2026 | **AGENTE DE FOLLOW-UP VIVO** 🤖✅ Jarbas criou a chave (Claude pilotou o Chrome até a porta; colar foi dele — regra de credencial) e configurou Anthropic + claude-haiku-4-5. Dois consertos no caminho: (a) loadAiConfig com requireActive:false (is_active é o interruptor do bot do INBOX, não do agente); (b) **bug de prefill**: conversa de follow-up quase sempre termina em mensagem NOSSA → API da Anthropic tratava como "continue a frase" e devolvia vazio — corrigido fechando o histórico com turno de usuário instruindo o JSON. Varredura real: detectou o TESTE-5001 (orçamento Eduardo), IA redigiu ("Opa Eduardo! Só querendo confirmar se chegou certinho o orçamento do Nitro 5...") com justificativa perfeita → queued:1 na fila. ATENÇÃO: a sugestão pendente é baseada em OS FICTÍCIA de um cliente REAL — decidir com edição ou descarte, não aprovar às cegas. | **CHECKPOINT FASE 5 BATIDO (05/08 22:22)** ✅🏆 — Jarbas aprovou em /followups e a mensagem SAIU pro WhatsApp (ciclo completo: detecção→IA→fila→aprovação→envio). Ressalva: aprovou SEM editar, então o Eduardo (real) recebeu menção ao orçamento fictício de R$ 890 — OS TESTE-5001 removida do banco; correção humana na conversa sugerida. **FASES 0-5 COMPLETAS — ESQUELETO PRONTO.** Próximo: ciclo de melhorias (§12) + publicação + troca da chave exposta. |
| 05/08/2026 | **RÉPLICA WHATSAPP WEB — leva 1 (P1).** Direção nova do Jarbas pós-esqueleto: inbox o mais fiel possível ao WhatsApp Web p/ zerar barreira de adoção da equipe. Entregues: (a) horários da lista no padrão WhatsApp (14:05 / ontem / segunda-feira / dd/mm/aaaa — formatWhatsAppTime em app-locale); (b) filtros em CHIPS visíveis (Tudo|Não lidas|Abertas|Pendentes|Fechadas) no lugar do dropdown; (c) seletor de EMOJIS 😀 no composer (grade 64 curados, popover, insere no cursor — sem lib externa); (d) botão flutuante "descer pro fim" (sticky na área de rolagem, aparece ao subir no histórico). 671 testes OK. | Leva 2 (P2) combinada: menu de contexto por conversa (marcar não lida/fechar/apagar), seleção múltipla c/ ações em massa, encaminhar mensagem, busca dentro da conversa. Leva 3 (P3): colar/arrastar imagem, "digitando..." via presence da Evolution. |
| 05/08/2026 | **RÉPLICA WHATSAPP WEB — leva 2 (funcionalidades), parte 1.** (a) Menu de contexto por conversa (chevron no hover, como no WhatsApp): marcar como não lida/lida, fechar/reabrir, apagar (com confirmação — apagar é destrutivo no CRM, não afeta o WhatsApp do cliente). (b) **Seleção múltipla**: botão ao lado dos chips entra no modo seleção (check no avatar), barra inferior com ações em massa (não lida/fechar/reabrir/apagar N). Atualização otimista + RLS. Nota técnica: linha virou div[role=button] (botão dentro de botão é HTML inválido); lint do React Compiler exigiu usar a prop direta em vez da ref nos callbacks novos. 671 testes/lint/build OK. | Restam da leva 2: encaminhar mensagem (dialog de contatos → send route) e busca dentro da conversa. Leva 3: colar/arrastar imagem, "digitando...". Jarbas: F5 e testar chevron + modo seleção. |
| 05/08/2026 | **RÉPLICA WHATSAPP WEB — leva 3: encaminhar + colar/arrastar.** (a) **Encaminhar mensagem**: botão Share na barra de hover da mensagem → dialog de contatos (busca, foto) → conteúdo (texto ou mídia) sai pela conversa do contato via /api/whatsapp/send com contact_id (find-or-create). Novo forward-dialog.tsx. (b) **Colar/arrastar arquivo**: Cmd+V com print/imagem no campo de texto ou soltar arquivo sobre o composer já prepara o anexo (reusa stageUpload; anel verde no drag-over; kindFromMime). 671 testes/lint/build OK. | Resta da réplica: busca dentro da conversa e "digitando..." (presence). Jarbas: F5 → testar encaminhar (hover na mensagem → ícone compartilhar) e Cmd+V de um print no chat. |
| 05/08/2026 | **FASE 6 — RADAR DE LEADS NO AR (peça 1)** 🎯🤖 Migration **045** APLICADA: conversation_insights (temperatura, interesse, resumo, momentos JSONB append-only, proximo_contato_em+motivo+promessa_atendida_em, escalado_em/motivo, controle de debounce), colunas de critérios em followup_settings (radar_enabled, contexto_negocio, criterios_quente/morno/frio, radar_debounce_minutos), cenário `promessa` no CHECK de followup_suggestions e modes radar/followup em ai_usage_log. Motor `insights/analyzer.ts`: elege conversas que esfriaram (debounce) com mensagem nova, manda histórico+dossiê anterior+critérios do dono à IA, parser defensivo (12 testes: rejeita data no passado/ilegível, temperatura fora do vocabulário, "true" string, JSON em cerca markdown), grava dossiê e dispara ações — tag exclusiva de temperatura no contato e escalada com notificação. Tick de 5 min no instrumentation + backstop /api/radar/cron. Retroalimentação: cenário `promessa` no followup engine (prioridade máxima, automático, consome promessa antes de gerar) + dossiê injetado no prompt de TODOS os cenários. UI: card Radar no topo da lateral (temperatura colorida, interesse, momentos com ícone, próximo contato) com realtime, e Settings → Radar de Leads p/ ensinar critérios em português. **BUGS ACHADOS E CORRIGIDOS (mesma raiz):** `profiles.role` é coluna TEXT legada valendo "user" p/ todos — o papel real é `account_role` (enum da 017). Isso quebrava SILENCIOSAMENTE (a) a criação da tag de opt-out em broadcast-inbound (§11.5 anti-ban!) e (b) o alerta de conexão travada, que notificava ninguém. **Teste real: 7 conversas analisadas, 0 erros** — South Import's morno (MacBook Air M1/M2, R$ 3.700–4.500, aceita usado, de São Leopoldo), Eduardo morno (gamer R$ 4–5 mil, objeção de preço), e acertou ao marcar a conversa PESSOAL da Isadora como indefinido. Tags morno aplicadas. 683 testes/lint/build OK. | **Jarbas: (1)** F5 no inbox → abrir Eduardo/South Import's → ver o card Radar na lateral; **(2)** Settings → Radar de Leads → ensinar os critérios da Oficina em português (o que faz um cliente ser QUENTE pra vocês). Peças restantes da §10.5: chips de funil com contadores, página Jornada e painel de scripts por categoria. |
| 05/08/2026 | **Etiquetas viram FUNIL — chips com contadores no inbox** 🎯 Pedido do Jarbas ("as etiquetas tbm poderemos manipular conforme o funil") = a peça (b) da §10.5, réplica dos chips da extensão. Migration **046** APLICADA: `tags.is_funnel_stage` + `tags.funnel_position` (índice parcial por conta) e as temperaturas do Radar já nascem no funil (quente 10, morno 20, frio 30). Inbox: chips do funil ao lado dos filtros de status, com CONTADOR calculado das conversas já carregadas (zero round-trip por chip), cor da própria etiqueta, clique liga/desliga o filtro (OR entre etiquetas, reusa matchesContactFilters). Settings → Campos e etiquetas: cada etiqueta ganhou botão "Funil" (liga/desliga) e setas de ordenação — posições reescritas em passos de 10 para caber inserção futura sem renumerar tudo; lista já ordenada como no inbox. 683 testes/lint OK, sem erros no servidor. | Jarbas: Settings → Campos e etiquetas → criar os estágios do funil da Oficina (ex.: QUALIFICAR, ORÇAMENTO PASSADO, RESERVOU, PAGO) e marcar "Funil" em cada um → voltar ao inbox e ver os chips com contador. Restam da §10.5: página Jornada (linha do tempo + conversão) e painel de scripts por categoria. |
| 05/08/2026 | **RADAR 2.0: intenção + aprendizado + JORNADA** 🧠🛣️ Visão do Jarbas: "chegam leads diferentes — quem já comprou e precisa de assistência, quem só quer informação, quem quer comprar — e cada situação tem caminhos diferentes"; "a IA vai aprendendo junto com o humano"; "ver há um ano o que foi conversado é sensacional". Migration **047** APLICADA. (a) **INTENÇÃO** (eixo independente da temperatura): compra|assistencia|orcamento|informacao|pos_venda|outro|indefinido — dá para ser QUENTE de assistência e morno de compra. Etiquetada automaticamente: `applyRadarTags` agora mantém DOIS grupos exclusivos (temperatura + intenção), ambos nascendo como estágios de funil (046) com cor e posição próprias. (b) **APRENDIZADO**: card do Radar virou editável (dropdowns de temperatura e intenção); corrigir grava em `radar_corrections`, FIXA o campo contra a IA (temperatura_fixada_em/intencao_fixada_em — soberania humana) e as últimas 12 correções entram no prompt como exemplos ("você classificou X, mas o certo para esta loja era Y"). Rota POST /api/radar/[conversationId]/classify; só registra quando o humano DISCORDA. (c) **JORNADA** (/jornada na sidebar): funil do período por temperatura + quebra por intenção, lista buscável de leads e LINHA DO TEMPO cronológica de cada um unindo momentos da IA + ordens de serviço + follow-ups enviados. (d) Robustez: resposta ilegível da IA agora loga o texto cru (início+fim) e marca a conversa como analisada — antes voltaria a cada tick queimando tokens para sempre. **Teste real: Eduardo e South Import's → 🛒 compra; Isadora → 💬 outro (conversa pessoal, acertou de novo).** 685 testes/lint/build OK. | Jarbas: (1) inbox → card do Radar → corrigir uma classificação e ver o Radar aprender; (2) sidebar → **Jornada** → clicar num lead e ver a linha do tempo. Resta da §10.5: painel de scripts por categoria (réplica do painel direito da extensão). |
| 05/08/2026 | **Ficha automática + jornada no contato + painel de scripts** 📇🛣️⚡ Três pedidos do Jarbas de uma vez. Migration **048** APLICADA. (a) **A IA PREENCHE A FICHA**: custom_fields ganhou `ai_managed` + `ai_hint` (dica em PT do que colocar) e contact_custom_values ganhou `source` (ai|human) — **humano é soberano, a IA nunca sobrescreve o que gente escreveu**. Campos-semente criados por conta: Cidade, Profissão, Equipamento, Como chegou. O analisador extrai e grava (parser recusa valores longos, "n/a", "não sei"). Lateral mostra a seção "Ficha do cliente" com ✨ no que veio da IA. **Teste real: preencheu "Cidade: São Leopoldo" no South Import's e foi conservadora no resto — não chutou.** (b) **JORNADA DENTRO DO CONTATO**: botão "Ver jornada completa" no card do Radar expande a linha do tempo ali mesmo (momentos + OS + follow-ups, com datas) — sem trocar de tela, como o Jarbas pediu. (c) **PAINEL DE SCRIPTS POR CATEGORIA**: quick_replies e message_scripts ganharam `categoria`; painel novo à direita (toggle ⚡ no header do thread, ocupa o lugar da lateral) agrupando as duas famílias por categoria, com busca, grupos recolhíveis e envio em 1 clique — réplica do painel direito da extensão. 685 testes/lint/build OK. | Jarbas: (1) inbox → ⚡ no topo → painel de scripts (categorize os itens em Configurações p/ agrupar); (2) card do Radar → "Ver jornada completa"; (3) lateral → seção Ficha do cliente. Com isso a §10.5 fecha inteira. |
| 05/08/2026 | **BUG de rolagem na lateral CORRIGIDO + criar respostas pelo painel.** (a) **Bug real do Jarbas** ("às vezes não consigo rolar para ver o resto dos campos"): clássico do flexbox — `ScrollArea` com `flex-1` dentro de coluna flex nasce com `min-height:auto` e CRESCE além do container em vez de rolar, cortando ficha/OSs/notas. Faltava `min-h-0`. Curiosidade: a lista de conversas já tinha esse conserto (com comentário explicando!), a lateral ficou de fora. (b) Painel de scripts ganhou **criação rápida inline**: nome + categoria (com autocomplete das categorias existentes) + texto → salva sem sair da conversa; atalho p/ Configurações → Scripts para sequências com mídia. 685 testes/lint/build OK. | Jarbas perguntou COMO a IA aprende — explicado (3 camadas: critérios ensinados, correções humanas viram exemplos no prompt, dossiê acumulado). Pediu mais status na Jornada além de temperatura → proposta de eixo SITUAÇÃO derivado anotada no roadmap §12, aguardando ele definir a lista. |
| 05/08/2026 | **BUG das fotos de perfil CORRIGIDO (2 causas).** Jarbas viu avatar genérico em vez das fotos. Investigação: URL respondia HTTP 200 mas com **0 bytes**. Causa 1: o script de backfill de ontem fazia POST sem corpo (a tentativa com bytes só rodava se a primeira falhasse — e ela retornava 200), gravando 7 arquivos vazios; refeito com `curl --data-binary`, agora 27–94 KB cada. Causa 2 (a que enganava): a URL pública passa por **CDN com cache de 1h** — mesmo após reescrever os arquivos, a versão vazia continuava sendo servida. Correção permanente em `avatar-sync.ts`: a URL gravada leva `?v=<timestamp>`, então uma troca de foto pelo cliente também aparece na hora em vez de esperar o cache expirar. URLs existentes recarimbadas. | Jarbas: F5 e ver as fotos. Pediu também: gravação de áudio no padrão WhatsApp Web (vai mandar print) e **MULTICANAL** (Instagram/Facebook) — arquitetura proposta no roadmap §12, para depois da publicação. |
| 05/08/2026 | **Passo "Enviar mídia" nas automações + pesquisa de IA multimídia.** (a) Apuração do relato do Jarbas ("nos fluxos e agentes não aparece voz/vídeo/imagem"): os FLUXOS já tinham o nó `send_media` (traduzido, com formulário e motor) — ele não achou o botão; as AUTOMAÇÕES realmente não tinham. Adicionado o passo `send_media` reusando `engineSendMedia` dos fluxos (mesma resolução de instância e nono dígito), com upload no builder, tipo e legenda com variáveis. (b) **docs/multimidia-ia.md** — pesquisa com preços OFICIAIS (ago/2026) respondendo as perguntas dele: **áudio** (Claude não escuta; Evolution API v2 tem speechToText NATIVO — liga uma flag + credencial OpenAI, ~R$ 4,60/mês, zero código; ARMADILHAS: URL/modelo hardcoded impedem usar Groq no modo nativo, e ela transcreve TAMBÉM os áudios que a loja envia — filtrar `fromMe`); **fotos/PDF** (Claude lê nativo, ~R$ 4–8/mês por 200 fotos no Haiku — melhor custo-benefício do pacote; vídeo NÃO, só extraindo quadros); **voz clonada** (ElevenLabs Creator US$ 22, Cartesia US$ 5, Fish US$ 1–11; PlayHT foi comprada pela Meta e ENCERROU. Risco maior não é multa e sim **banimento do número** por áudio sintético em escala — recomendação: só conteúdo informativo repetitivo e COM aviso). Ordem sugerida: transcrição → visão → voz. | Jarbas decidir o que ligar. Pendente: gravação de áudio no padrão WhatsApp Web (aguardando print dele). |
| 05/08/2026 | **CENTRAL DE RECURSOS** 🎛️ (ideia do Jarbas: "um lugar pra ligar/desligar esses recursos, testar se está funcionando, monitorar — se eu quiser que seja só um app onde eu respondo à mão, é"). Migration **049** APLICADA: `account_features` (chave por recurso, RLS leitura p/ todos e escrita admin+, realtime ligado). Regras de ouro em `lib/features/catalog.ts`: **padrão LIGADO** (recurso sem linha funciona — nada quebra em conta existente, recurso novo não precisa de backfill) e **MODO MANUAL manda** (derruba todo automatismo de uma vez, sem apagar a escolha individual — desligou o manual, tudo volta como era). `lib/features/guard.ts` com cache de 30s e política de "falha de leitura NÃO desliga a operação". Guardas plugadas em: Radar, agente de follow-up, bot de auto-resposta, automações, fila de transmissões e fila de agendadas. Tela Settings → Central de Recursos (primeira do menu): cada recurso com interruptor, selo de saúde (Funcionando / Desligado / Falta configurar / Com problema), botão **Testar** e última atividade; disjuntor do modo manual em destaque no topo. Rota `/api/features/status` (GET diagnóstico, POST teste real — chama a IA de verdade ou consulta a conexão da Evolution). 685 testes/lint/build OK. | Jarbas: Configurações → Central de Recursos. Decisão dele registrada em docs/multimidia-ia.md: NÃO quer aviso de áudio sintético (risco que fica: banimento do número, não multa). Próximo combinado: (1) transcrição de áudio, (2) visão de fotos, (3) voz. |
| 05/08/2026 | **Barra de gravação de áudio no padrão WhatsApp Web** 🎙️ (print do Jarbas). Antes: ponto vermelho + "0:04 / 5:00" + link Cancelar + botão quadrado. Agora, a barra dele: **lixeira** (descartar) · ponto vermelho + tempo · **ONDA DA VOZ AO VIVO** · **pausar/continuar** · botão verde de enviar. Novo `voice-waveform.tsx`: pendura um AnalyserNode no grafo de áudio que o opus-recorder já montou (sem abrir o microfone duas vezes), calcula RMS a cada ~60ms e desenha 48 barras rolando num canvas — canvas e não divs porque redesenha ~30x/s. Degrada limpo: navegador que não exponha o contexto de áudio grava normalmente, só sem a onda. Pausa usa pause/resume do opus-recorder (não perde o que já gravou) e o timer congela junto via ref (ele roda fora do React). 685 testes/lint/build OK. | Jarbas testar: microfone no composer → falar → ver a onda mexer → pausar → continuar → enviar. Próximo combinado: transcrição de áudio (item 1). |
| 05/08/2026 | **Onda de voz CORRIGIDA + fixar conversa.** (a) Jarbas relatou que a onda ficava reta mesmo falando. Causa: pegadinha clássica do Web Audio — um nó **sem caminho até a saída não é processado** pelo navegador; o AnalyserRodava pendurado só no source, sem destino, e devolvia silêncio. Conserto: analisador → ganho ZERO → destination (força o processamento sem emitir som), mais `ctx.resume()` se o contexto nascer suspenso e desconexão do nó ao parar. (b) **Fixar conversa** (pedido dele, print do menu do WhatsApp): migration **050** APLICADA (`conversations.pinned_at` + índice parcial), item Fixar/Desafixar no menu de contexto, alfinete na linha e ordenação com as fixadas no topo (sort estável preserva a ordem original dentro de cada grupo). É por CONTA, não por usuário — a lista do inbox é compartilhada pela equipe. 685 testes/lint/build OK. | Jarbas: testar a onda (microfone → falar) e o fixar (menu ˅ da conversa). Restante do menu do WhatsApp anotado no roadmap §12: silenciar, favoritos, bloquear, limpar conversa. |
| 08/08/2026 | **RADAR ALIMENTA O FUNIL DE VENDAS** 💰 (pedido do Jarbas: "a IA colocar no pipeline o valor que o cliente está disposto a gastar, baseado no momento de compra... e abrir opções ali na conversa pra mexer de forma manual"). (a) Migration **051**: `pipeline_stages.radar_stage` (vocabulário canônico novo/qualificado/negociando/reservado/ganho/perdido — a IA nunca fala o nome do estágio do dono), `conversation_insights.valor_estimado/valor_origem/deal_id`, `deals.created_by_radar/value_locked_at/stage_locked_at`. (b) Migration **052**: o funil real ainda era o template em inglês — virou Novo lead → Qualificado → Orçamento enviado → Negociando → **Reservado** → **Comprou** → **Perdido** (os dois momentos que ele citou e não existiam). (c) `src/lib/insights/deal-sync.ts`: só abre card com intenção de compra + sinal concreto (curiosidade não entope o funil), só mexe no que a IA controla, e **nunca anda para trás** (duas travas: ordem do funil + posição na tela, esta cobre o estágio que o dono criou sem mapear). (d) O analisador pede `valor_estimado`, `valor_origem` e `estagio` no prompt e chama o deal-sync depois de salvar o dossiê. (e) **Controles manuais**: valor clicável para editar e seletor de estágio no card do negócio na lateral da conversa (`PATCH /api/deals/{id}/quick`), e arrastar o card no board também trava — mexeu na mão, a IA para de mexer naquele campo. ✨ marca o que veio do Radar. **Teste real**: 3 conversas reanalisadas → Eduardo Maciel (notebook gamer, R$ 5.000, Qualificado) e South Import's (MacBook Air M1, R$ 4.500, Orçamento enviado) viraram negócios sozinhos; a terceira (fria, sem valor) corretamente não virou card. Bug pego no teste: `status: 'active'` violava o CHECK da tabela (só aceita open/won/lost) — agora 'ganho'→won e 'perdido'→lost. 12 testes novos, **702 testes**, typecheck/lint/build OK. | Jarbas: abrir uma conversa de compra e conferir o card do negócio (clicar no valor, trocar o estágio) + ver o board em /pipelines. **Obs.: existem dois funis duplicados** ("Sales Pipeline" e "Vendas", ambos vazios e idênticos) — o Radar usa o mais antigo; posso apagar o outro se ele confirmar. Próximo da fila combinada: **transcrição de áudio** (Evolution nativa, ~R$ 4,60/mês), depois visão (fotos/PDF) e clonagem de voz. |
| 08/08/2026 | **PONTE OS → FUNIL + o achado que salvou as 66 cobranças.** O Jarbas apontou a sessão do sistema de OS dele (`Projetos/oficina-info-sistema`, Next+Prisma) e eu li o código em vez de adivinhar. **Descoberta:** aquele sistema NÃO tem enum de status — as colunas do kanban são linhas em `KanbanColumn`, então o que trafega é o NOME da coluna em português com acento e espaço ("Aguardando retirada"). O CRM comparava contra `'pronto'`, `'entregue'` e `'orcamento_enviado'`, que **não existem lá**: a integração podia ser ligada e não sairia NENHUMA cobrança, sem erro nenhum. Criado `src/lib/os/status-map.ts` (ignora acento/caixa/separador; mapeia as 12 colunas reais + os slugs antigos; coluna desconhecida vira 'desconhecido', avisa no log e NÃO move nada) e religados os 3 cenários de cobrança. Criado `src/lib/os/deal-bridge.ts` + chamada no `POST /api/v1/os-events` (em .catch, nunca derruba o 201): "Aguardando recebimento" só espelha (máquina ainda com o cliente); qualquer coluna da bancada em diante move o card para "Máquina na loja", marca `won` e TRANCA — e respeita card que alguém arrastou à mão (só espelha, e avisa no log). 27 testes novos, **741 no total**. `docs/integracao-os.md` ganhou a tabela de tradução coluna→situação. **Prova no banco real, cadeia inteira**: Radar criou o card em "Vai trazer" → OS "Aguardando recebimento" NÃO moveu (só espelhou) → OS "Aguardando retirada" pulou para "Máquina na loja", won, travado. Card de teste removido. | **O que falta para o dinheiro entrar:** o Jarbas gerar a chave de API no CRM (Settings) e pedir ao sistema de OS para dar POST em `/api/v1/os-events` a cada mudança de coluna, mandando `status` = nome da coluna. Aí acordam as 9 cobranças de orçamento e as 57 de retirada. **Decisão pendente dele:** hoje a ponte RESPEITA card arrastado à mão (só espelha); se ele preferir que a OS vença, é apagar o `if (deal.stage_locked_at)` do deal-bridge. **Ainda pendente:** botão "Recebi a máquina", botões "Virou venda/serviço" com motivo, lista "Leads de conserto sem card", selo do tipo de funil, guarda de contagem no `handleDeletePipeline` (hoje apagar funil apaga os cards em cascata, em silêncio) e o cenário `lead_frio` morto (`engine.ts` filtra `status='active'`, valor que o CHECK não permite). |
| 08/08/2026 | **FUNIL DE SERVIÇO NO AR (053).** O Radar agora decide o QUADRO antes de abrir o card: quer comprar → funil de Vendas; tem máquina com problema → funil de **Serviço** (Novo conserto → Problema identificado → Valor passado → Vai trazer/vamos buscar → Máquina na loja (OS aberta) → Não veio). Reaproveita as mesmas seis palavras canônicas da 051, então nenhum CHECK mudou e a 052 é no-op no funil novo. **Regras**: a IA declara o funil no dossiê (campo `funil`) e a intenção é só a rede embaixo; sem funil daquele tipo o Radar NÃO cria nada (nunca despeja conserto em vendas); teto em duas camadas impede a IA de dizer 'máquina na loja' (o prompt proíbe, o código rebaixa para 'reservado'); card de serviço nasce com R$ 0 (orçamento de verdade é o da bancada); a busca no serviço filtra `status='open'` senão quem já teve máquina na bancada nunca mais geraria conserto. **Conserto de brinde**: `analyzer.ts` passava a intenção CRUA para o funil — agora passa `intencaoFinal`, então corrigir a intenção no card do Radar redireciona o quadro. **Painel**: loadMetrics, donut e atividade recente filtram `pipelines.tipo='vendas'` — sem isso o painel somaria chute de conserto com preço de notebook. 24 testes novos (714 no total), typecheck/lint/build OK, migration aplicada. **Prova no banco real**: conserto do Eduardo nasceu em [servico/Serviço] 'Vai trazer' R$0 open, a IA tentou 'ganho' e foi rebaixada, e o mesmo contato ficou com card nos DOIS quadros (o card de teste foi removido depois). | **Pendente e por quê:** (1) **ponte OS→card** — depende de saber o vocabulário REAL de `status` do sistema de OS; `aguardando_recebimento` é nome de COLUNA do kanban, não valor contratado, e até saber a lista o default seguro é 'desconhecido NÃO move'; (2) botão 'Recebi a máquina', botões 'Virou venda/serviço' com motivo, lista 'Leads de conserto sem card', selo do tipo de funil; (3) **`handleDeletePipeline` apaga o funil SEM contar negócios** e `deals.pipeline_id` é ON DELETE CASCADE — apagar funil apaga cards em silêncio; precisa da guarda que `handleRemoveStage` já tem; (4) **cenário `lead_frio` está MORTO** — `followups/engine.ts:460` filtra `status='active'`, valor que o CHECK não permite; consertar ACORDA mensagem para cliente real, então vai isolado e com filtro de funil no mesmo commit. **Bloqueado no lado do Jarbas:** a integração da OS nunca foi ligada (0 chaves de API, 0 os_events) — é isso que segura as 9 cobranças de orçamento e as 57 de retirada. Os dois funis de vendas duplicados continuam lá (NÃO apaguei — 'Sales Pipeline' tem os 2 negócios, 'Vendas' está vazio). |
| 08/08/2026 | **FUNIL DE SERVIÇO x FUNIL DE VENDAS — estudo em andamento (PAUSA AQUI).** Pedido do Jarbas: o Radar deve perceber se o cliente quer SERVIÇO e abrir o card num funil de serviço (cujo objetivo é trazer a pessoa à loja ou agendar a coleta da máquina); depois que a máquina chega, quem manda é o sistema de OS dele; e o cliente pode trocar de funil a qualquer momento. Ele mandou prints do kanban do sistema de OS e eles estão registrados coluna por coluna em **`docs/funil-servico.md`** (commit 51c2970): 12 colunas, 87 OSs ativas — Aguardando recebimento, Orçamento a fazer, Revisões, Em levantamento, Enviar orçamento, Aguardando cliente, Autorizado, Em serviço, Aguardando peça, Pronto para entrega, Aguardando retirada, Finalizada. **Decisão de arquitetura que os prints forçam:** o CRM NÃO reproduz esse kanban (a verdade do serviço mora na OS); o funil de serviço do CRM é só o PRÉ-loja, e depois do recebimento o card espelha o status da OS. **Dois números que valem dinheiro** e que o agente de follow-up já sabe cobrar: 9 OSs em "Aguardando cliente" (orçamento enviado sem resposta, uma parada há ~1 mês) e 57 em "Aguardando retirada" (máquina pronta, cliente não buscou). | **RETOMAR AQUI:** rodou um workflow de desenho (5 frentes de estudo + 3 desenhos independentes + crítico) — run `wf_8bc37904-23e`, script em `.claude/.../workflows/scripts/funil-servico-desenho-wf_8bc37904-23e.js`, transcrições em `subagents/workflows/wf_8bc37904-23e`. Se o resultado tiver se perdido, é só rodar o script de novo (agora com os prints do kanban no contexto, que ele NÃO tinha). Depois: fechar o plano em `docs/funil-servico.md` e implementar. **O Jarbas ainda vai escolher** entre começar pelo funil de serviço ou pelas 66 cobranças (9 orçamentos + 57 retiradas). Fila combinada depois disso: transcrição de áudio (~R$ 4,60/mês), visão (fotos/PDF), clonagem de voz. |

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
