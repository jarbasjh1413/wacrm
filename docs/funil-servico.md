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

## A decisão (08/08/2026) — migration 053

**Um carimbo no funil, o mesmo vocabulário de seis palavras.**
`pipelines.tipo` = `vendas` | `servico`. Os dois quadros reaproveitam as
mesmas seis palavras canônicas da 051 (novo/qualificado/negociando/
reservado/ganho/perdido) — o que muda é o SIGNIFICADO delas dentro de cada
quadro, não o vocabulário. Assim nenhum CHECK muda, o código de ordenação
não muda, e a 052 é no-op genuíno no funil novo.

### O quadro de Serviço

| # | Coluna | Palavra da IA | O que significa |
|---|---|---|---|
| 0 | Novo conserto | `novo` | falou que tem um problema, sem detalhe |
| 1 | Problema identificado | `qualificado` | sabemos o equipamento E o defeito |
| 2 | Valor passado | `negociando` | já passamos faixa de preço, taxa ou prazo |
| 3 | Vai trazer / vamos buscar | `reservado` | combinado CONCRETO, com dia — **teto da IA** |
| 4 | Máquina na loja (OS aberta) | `ganho` | **proibido para a IA** — só a OS ou o botão manual |
| 5 | Não veio | `perdido` | desistiu, sumiu, resolveu sem OS ou virou venda |

O "ganho" aqui é a **máquina na bancada**, não dinheiro. Por isso o card de
serviço nasce com valor R$ 0: o único orçamento que vale é o da bancada, e
ele vem da OS.

### As regras que protegem o board

1. **A IA declara o quadro** (campo `funil` no dossiê). A intenção sozinha
   não decide: *"quanto custa trocar a tela"* e *"quanto custa um notebook
   i5"* são a mesma intenção em quadros diferentes. Se ela não souber, a
   intenção é a rede: compra→vendas, assistencia/pos_venda→servico, resto
   → **nenhum quadro** (e aí a IA acerta o valor, mas não move de coluna).
2. **Nunca o quadro errado.** Sem funil de serviço na conta, o Radar não
   cria nada — silêncio é melhor que card no lugar errado.
3. **Teto da IA em duas camadas**: o prompt proíbe `ganho` no serviço, e o
   código rebaixa para `reservado` se ela tentar mesmo assim.
4. **Card de serviço ganho não bloqueia um conserto novo.** A busca no
   quadro de serviço filtra `status = 'open'` — senão o cliente cuja
   máquina já passou pela bancada nunca mais geraria card (segunda
   máquina, a da esposa, o notebook da empresa).
5. **O card nunca troca de quadro.** Conserto que vira venda abre card novo
   no outro quadro, amarrado por `relacionado_deal_id` **e escrito só por
   gente** — se a IA amarrasse sozinha, o cliente que conserta E compra
   (o cliente comum da loja) entraria no relatório como conversão.

### O painel deixou de somar laranja com banana

`loadMetrics`, o donut do funil e a atividade recente passaram a filtrar
`pipelines.tipo = 'vendas'`. Sem isso, no dia seguinte o painel começaria a
somar chute de conserto com preço de notebook, e a atividade recente viraria
um log do sistema de OS.

## O que ainda NÃO está feito

- **A ponte OS → card** (mover para "Máquina na loja" quando o evento
  chegar). Depende de saber o vocabulário REAL de `status` do sistema de
  OS: `aguardando_recebimento` é o nome de uma COLUNA do kanban, não um
  valor de payload contratado (`docs/integracao-os.md:43` lista outros).
  Enquanto a lista real não for conhecida, o default seguro é **status
  desconhecido NÃO move o card**.
- **Botão "Recebi a máquina"** (plano B para quando o evento não chegar).
- **Botões "Virou venda" / "Virou serviço"** com motivo, e a lista
  "Leads de conserto sem card".
- **Selo do tipo de funil** no seletor e nos cards.
- **`handleDeletePipeline` não conta os negócios antes de apagar** — e
  `pipelines.id` tem `ON DELETE CASCADE` em deals. Apagar um funil hoje
  apaga os cards dele em silêncio. Precisa da mesma guarda que
  `handleRemoveStage` já tem.
