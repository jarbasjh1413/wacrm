# Funil de serviço x funil de vendas

> Pedido do Jarbas, 08/08/2026: *"seria legal diferenciar funil de serviço e
> funil de vendas. O Radar poderia fazer essa diferenciação: se o cliente quer
> serviço, criar ele dentro de um funil de serviço, onde a tentativa é trazer o
> cliente pra loja, ou coletar alguma máquina. Depois, quando a máquina for
> coletada e feita a OS e estiver aqui, daí eu tenho o funil meio que pronto
> com base no nosso sistema de ordem de serviço. Mas também um cliente a
> qualquer momento pode sair da ordem de serviço e virar um cliente dentro de
> um funil de vendas."*

## O kanban REAL do sistema de OS (prints do Jarbas, 08/08/2026)

O sistema de Ordem de Serviço dele (`Oficina Informática — Sistema de gestão`,
menu: Início · Kanban · Fila de serviços · Nova OS · Clientes · Equipamentos ·
Peças · Relatórios · Financeiro · Dashboard) **já tem um kanban completo do
serviço**, com 87 OSs ativas no dia do print:

| # | Coluna | Qtd | O que significa |
|---|---|---|---|
| 1 | Aguardando recebimento | 1 | OS aberta, **máquina ainda não chegou** |
| 2 | Orçamento a fazer | 9 | Máquina na bancada, falta orçar |
| 3 | Revisões | 0 | — |
| 4 | Em levantamento | 2 | Diagnóstico em andamento |
| 5 | Enviar orçamento | 1 | Orçamento pronto, falta mandar pro cliente |
| 6 | **Aguardando cliente** | **9** | Orçamento enviado, **esperando a resposta dele** |
| 7 | Autorizado | 1 | Cliente aprovou |
| 8 | Em serviço | 1 | Técnico trabalhando |
| 9 | Aguardando peça | 6 | Parado esperando peça |
| 10 | Pronto para entrega | 0 | — |
| 11 | **Aguardando retirada** | **57** | Pronta, **cliente não veio buscar** |
| 12 | Finalizada | 258 | Encerrada (fora da contagem de ativas) |

Cada card traz: nº da OS (#7202), equipamento + código (`Dell Inspiron 13 5301
EQ-0335`), nome do cliente, relato do problema, etiquetas de prioridade
(Baixa/Alta/Urgente), marcadores (`Dados`, `Gar` de garantia, `REMOTO`),
contagem de fotos, técnico responsável (Leonardo, Gustavo, Arthur, Pedro) e
"há X dias".

### A conclusão que isso força

**O CRM não pode reproduzir esse kanban.** Ele já existe, é bom, e a verdade
sobre o serviço mora lá. Se o CRM criar colunas paralelas, os dois sistemas
passam a discordar e ninguém confia em nenhum.

O funil de serviço do CRM é o **pré-loja** — o pedaço que a OS *não* cobre,
porque ainda não existe máquina:

```
    CRM manda aqui                          OS manda aqui
┌──────────────────────────┐   fronteira  ┌───────────────────────────┐
│ conversa no WhatsApp     │      │       │ Aguardando recebimento    │
│ → quer trazer / coletar  │      │       │ → ... → Finalizada        │
│ → agendado               │  ────┼────►  │                           │
└──────────────────────────┘   máquina    └───────────────────────────┘
                               chega
```

Depois da fronteira, o card do CRM **espelha** o status da OS (o evento chega
por `POST /api/v1/os-events`, ver `docs/integracao-os.md`) em vez de ter vida
própria.

### Duas minas de ouro que os prints revelaram

Números do dia do print, que são exatamente o trabalho do agente de follow-up
(Fase 5) e do Radar (Fase 6):

- **9 OSs em "Aguardando cliente"** — orçamento enviado, esperando resposta.
  Um dos cards (OS #6937, Acer Aspire E1) está parado **há cerca de 1 mês**.
  Cada um desses é dinheiro parado esperando um "e aí, posso fazer?".
- **57 OSs em "Aguardando retirada"** — máquina pronta, cliente não veio buscar.
  Ocupa bancada, prateleira e capital.

O CRM já sabe cobrar esses dois casos por WhatsApp com mensagem gerada pela IA e
contexto do cliente. É a integração de maior retorno imediato do projeto.

## Status

Desenho em elaboração (workflow `funil-servico-desenho`, 08/08/2026).
Este documento guarda os fatos apurados; a decisão final e os passos de
implementação entram aqui embaixo quando fecharem.
