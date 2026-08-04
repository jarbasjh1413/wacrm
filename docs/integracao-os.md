# Integração CRM ↔ Sistema de OS

Contrato da Fase 4 (CLAUDE.md §9). Bancos separados; toda comunicação é
por API REST autenticada. Este documento é a referência para implementar
o lado do **sistema de OS** (projeto Next.js 14 + Prisma, separado).

## Sentido 1 — OS → CRM (eventos) ✅ implementado no CRM

A cada evento relevante de uma ordem de serviço (criação, mudança de
status, entrega), o sistema de OS chama:

```
POST {CRM_BASE_URL}/api/v1/os-events
Authorization: Bearer {API_KEY}
Content-Type: application/json
```

- **API key**: criada no CRM em **Configurações → Chaves de API**, com o
  escopo **`os:write`**. Enviada no header `Authorization: Bearer wacrm_live_...`.
- **Rate limit**: o padrão da API v1 (por chave). Reenvios em caso de
  erro 5xx são seguros — cada chamada vira um evento novo (histórico),
  e o estado atual de uma OS é o evento mais recente do `os_id`.

### Payload

```json
{
  "os_id": "1234",
  "evento": "status_alterado",
  "status": "pronto",
  "cliente": { "nome": "Fulano da Silva", "telefone": "+5551999998888" },
  "equipamento": "Notebook Dell Inspiron 15",
  "valor_orcamento": 450.0,
  "data_evento": "2026-08-04T14:00:00Z",
  "unidade": "canoas"
}
```

| Campo | Obrigatório | Notas |
|---|---|---|
| `os_id` | ✅ | Identificador da OS no sistema de origem (string). |
| `evento` | ✅ | Livre; sugerido: `os_criada`, `status_alterado`, `os_entregue`. |
| `status` | — | Vocabulário do sistema de OS (`pronto`, `orcamento_enviado`, `aguardando_aprovacao`, `entregue`, ...). Sem CHECK no CRM: status novos não quebram nada. |
| `cliente.telefone` | ✅ | E.164 (`+55DDDNÚMERO`). O CRM acha ou **cria** o contato por ele. |
| `cliente.nome` | — | Usado ao criar contato novo. |
| `equipamento` | — | Texto livre; aparece na lateral da conversa. |
| `valor_orcamento` | — | Número (reais). |
| `data_evento` | — | ISO-8601; default = agora. |
| `unidade` | — | `canoas` \| `sapucaia` \| ... |

O payload bruto inteiro também é guardado (`os_events.payload`), então
campos extras que o sistema de OS mandar não se perdem.

### Respostas

- `201` — `{ "data": { "event": {...}, "contact": { "id": "...", "created": true|false } } }`
- `400` — validação (campo faltando, telefone inválido, JSON malformado)
- `401` / `403` — chave ausente/ inválida / sem o escopo `os:write`
- `429` — rate limit (reenviar com backoff)

### Exemplo (curl)

```bash
curl -X POST "$CRM_BASE_URL/api/v1/os-events" \
  -H "Authorization: Bearer $CRM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "os_id": "1234",
    "evento": "status_alterado",
    "status": "pronto",
    "cliente": { "nome": "Cliente Teste", "telefone": "+5551999998888" },
    "equipamento": "Notebook Dell Inspiron 15",
    "valor_orcamento": 450.00,
    "data_evento": "2026-08-04T14:00:00Z",
    "unidade": "canoas"
  }'
```

### O que o CRM faz com o evento

1. Resolve o contato pelo telefone (cria se não existir — mesmo
   find-or-create do webhook do WhatsApp, com dedupe).
2. Grava em `os_events` (histórico completo, uma linha por evento).
3. A lateral da conversa passa a mostrar as OSs do cliente (estado
   atual por `os_id`: equipamento, status, valor, unidade).
4. (Fase 5) O agente de follow-up varre `os_events` para os cenários
   "equipamento pronto não retirado", "pós-venda" e "orçamento sem
   resposta".

## Sentido 2 — CRM → OS (consulta) 🔜 a implementar no sistema de OS

Para a lateral mostrar TODAS as OSs (não só as que geraram eventos), o
sistema de OS deve expor:

```
GET {OS_BASE_URL}/api/clientes/{telefone}/ordens
Authorization: Bearer {OS_API_KEY}
```

- `{telefone}`: E.164 URL-encoded (`%2B5551...`).
- Resposta sugerida:

```json
{
  "ordens": [
    {
      "os_id": "1234",
      "status": "pronto",
      "equipamento": "Notebook Dell Inspiron 15",
      "valor_orcamento": 450.0,
      "criada_em": "2026-07-28T10:00:00Z",
      "atualizada_em": "2026-08-04T14:00:00Z",
      "unidade": "canoas"
    }
  ]
}
```

Quando esse endpoint existir, o CRM ganha as env vars `OS_API_BASE_URL`
e `OS_API_KEY` e a lateral consulta ao vivo (com cache curto), usando
`os_events` como fallback offline.

## Checkpoint da Fase 4

1. No sistema de OS: mudar o status de uma OS de teste → ver o evento
   chegar no CRM (`os_events`) e a OS aparecer na lateral da conversa
   do cliente.
2. Enviar payload com telefone novo → conferir que o contato foi criado.
