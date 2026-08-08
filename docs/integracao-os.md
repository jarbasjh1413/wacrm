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
| `status` | ✅ na prática | **Mande o NOME da coluna do kanban**, igual ele aparece na tela: `Aguardando retirada`, `Aguardando cliente`, `Em serviço`... Ver a tabela de tradução abaixo. Sem CHECK no CRM: nome novo não quebra nada, mas também não dispara nada até ser mapeado. |
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


---

## O vocabulário de `status` (conferido no código, 08/08/2026)

O sistema de OS da Oficina (`Projetos/oficina-info-sistema`) **não tem enum
de status**: as colunas do kanban são linhas na tabela `KanbanColumn`, então
o que existe é o `name` da coluna — em português, com acento e espaço.

Isso quase custou caro: o CRM comparava contra `'pronto'`, `'entregue'` e
`'orcamento_enviado'`, que **não existem** naquele sistema. A integração
podia ser ligada e não sairia **nenhuma** cobrança, sem nenhum erro.

O tradutor vive em `src/lib/os/status-map.ts` e ignora acento, caixa e
separador (`Aguardando Retirada`, `aguardando-retirada` e
`AGUARDANDO_RETIRADA` são a mesma coisa).

| Coluna no kanban da OS | Situação no CRM | O que o CRM faz |
|---|---|---|
| Aguardando recebimento | `aguardando_recebimento` | **Não move o card** — a máquina ainda está com o cliente. Continua cobrando "que dia você traz?" |
| Orçamento a fazer | `na_bancada` | Card vai para "Máquina na loja" e trava |
| Revisões | `na_bancada` | idem |
| Em levantamento | `na_bancada` | idem |
| Enviar orçamento | `na_bancada` | idem |
| **Aguardando cliente** | `aguardando_cliente` | 💰 cobrança de **orçamento sem resposta** |
| Autorizado | `na_bancada` | idem |
| Em serviço | `na_bancada` | idem |
| Aguardando peça | `na_bancada` | idem |
| Pronto para entrega | `pronto` | 💰 cobrança de **equipamento pronto** |
| **Aguardando retirada** | `pronto` | 💰 cobrança de **equipamento pronto** |
| Finalizada | `finalizada` | pós-venda |

Os slugs do contrato original (`pronto`, `orcamento_enviado`,
`aguardando_aprovacao`, `entregue`) continuam aceitos — quem implementar
pelo texto antigo não quebra.

**Coluna nova?** O CRM registra o evento, espelha no card como
`desconhecido`, escreve um aviso no log (`[os] status não mapeado: ...`) e
**não move nada**. Marcar "chegou" cedo demais tiraria o card da fila de
cobrança justamente quando ele ainda precisa ser cobrado. É só acrescentar
a linha no `MAPA` do `status-map.ts`.
