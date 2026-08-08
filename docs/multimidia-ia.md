# IA multimídia: o que dá, o que custa (pesquisa 08/2026)

Levantamento a pedido do Jarbas: a IA vai entender áudios? fotos? dá para
mandar áudio com a voz dele? quanto custa? Preços verificados nas páginas
oficiais dos fornecedores em agosto/2026 — **reconfira antes de contratar**,
preço de IA muda rápido.

Volume-base assumido para a Oficina: **300 áudios recebidos/mês** (~30s cada),
**200 fotos/mês**, **200 áudios enviados/mês** (~20s). Dólar ~R$ 5,10.

---

## 1. Entender ÁUDIO do cliente (transcrição)

A IA que usamos (Claude) **não escuta áudio** — a doc oficial diz que áudio é
ignorado na entrada. O caminho é transcrever antes e mandar o texto.

| Opção | Custo/mês | Esforço |
|---|---|---|
| **Evolution API nativa** (liga uma flag + credencial OpenAI) | ~R$ 4,60 | **zero código** |
| Groq Whisper large v3 (transcrever no CRM) | ~R$ 1,40 | ~30 linhas |
| OpenAI `gpt-4o-mini-transcribe` (no CRM) | ~R$ 2,30 | ~30 linhas |
| Deepgram Nova-3 | ~R$ 5,90 | integração própria |

**Recomendação: ligar o `speechToText` nativo da Evolution.** Nesse volume a
diferença entre as opções é de centavos — o que importa é não escrever código.

⚠️ **Duas armadilhas confirmadas:**
1. A transcrição nativa da Evolution tem a URL da OpenAI e o modelo
   `whisper-1` **fixos no código** — não dá para apontar para a Groq.
2. Ela transcreve **TODOS** os áudios da instância, inclusive os que a
   Oficina ENVIA (issue EvolutionAPI/evolution-api#1099). Filtrar por
   `key.fromMe` no nosso webhook, senão pagamos para transcrever a nós mesmos.

Sem benchmark oficial confiável de qualidade em PT-BR — testar com 20-30
áudios reais de cliente (com gíria, nome de peça, ruído de bancada) antes de
fechar fornecedor.

---

## 2. Entender FOTO, PDF e VÍDEO

| Tipo | Claude aceita? | Custo |
|---|---|---|
| **Foto** (JPEG/PNG/WebP, até 8000px, 10 MB) | ✅ nativo | ~R$ 0,01/foto no Haiku → **~R$ 4 a 8/mês** |
| **PDF** (até 600 páginas) | ✅ nativo | ~R$ 0,03/página |
| **Vídeo** | ❌ | extrair quadros com ffmpeg + transcrever o áudio |
| **Áudio** | ❌ | transcrever antes (seção 1) |

**É o melhor custo-benefício do pacote.** Cliente manda foto da tela trincada
ou da etiqueta com o modelo → a IA lê e preenche a ficha sozinha. No Haiku 4.5
uma foto grande sempre trava em ~1.560 tokens, então o custo é previsível.

Preços Claude (por milhão de tokens): **Haiku 4.5** US$ 1 entrada / US$ 5
saída · Sonnet 5 US$ 2/10 (promocional até 31/08/2026, depois 3/15) ·
Opus 5 US$ 5/25.

---

## 3. Mandar ÁUDIO com a voz do Jarbas (clonagem)

| Serviço | Clonagem? | Custo/mês | Nota |
|---|---|---|---|
| **ElevenLabs** Creator | ✅ profissional | **US$ 22** (~R$ 112) | PT-BR nativo comprovado; o mais maduro |
| **Cartesia** Pro | ✅ instantânea | US$ 5 (~R$ 26) | franquia apertada p/ esse volume |
| **Fish Audio** | ✅ (amostra de 15s) | US$ 1–11 | mais barato; menos maduro |
| OpenAI TTS | ⚠️ só sob aprovação comercial | ~US$ 1 | na prática, sem clonagem: 13 vozes fixas |

⚠️ **PlayHT/PlayAI foi comprada pela Meta e encerrada — não considerar.**

### O ponto que não é técnico
Clonar a **própria** voz é legal. O problema é **não avisar o cliente**. Riscos
reais, em ordem de probabilidade:
1. **Banimento do número no WhatsApp** (áudio sintético em escala é padrão de
   spam) — perderíamos a operação inteira;
2. Quebra de confiança se o cliente descobrir;
3. LGPD/CDC; o PL 2338/2023, se aprovado, prevê sanções pesadas.

**DECISÃO DO JARBAS (05/08/2026): não quer o aviso.** Registrado — é o
negócio e a voz dele. O risco que permanece na mesa é operacional, não
jurídico: áudio sintético em escala é padrão de spam e o WhatsApp bane
número por isso. Revisitar quando a voz for realmente implementada
(item 3 da ordem).

Recomendação original mantida para referência:
usar voz sintética só em conteúdo **informativo repetitivo** (como chegar na
loja, explicação de garantia), nunca em negociação ou conversa pessoal, e com
um aviso do tipo "áudio gravado automaticamente".

---

## Resumo da conta

| Cenário | Custo/mês |
|---|---|
| **Entender áudio + foto** (o que muda o jogo) | **~R$ 10** |
| \+ voz clonada (ElevenLabs Creator) | ~R$ 122 |
| \+ voz clonada (Cartesia/Fish, mais barato) | ~R$ 30 a 40 |

**Ordem sugerida:** (1) transcrição via Evolution nativa — quase de graça e
resolve a dor real de "o cliente mandou áudio e ninguém ouviu"; (2) visão de
fotos no Radar — barato e alimenta a ficha sozinho; (3) voz clonada por
último, se ainda fizer sentido, com aviso ao cliente.
