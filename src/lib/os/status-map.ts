/**
 * Tradutor entre o sistema de Ordem de Serviço e o CRM.
 *
 * O sistema de OS do Jarbas (`Projetos/oficina-info-sistema`) NÃO tem um
 * enum de status: as colunas do kanban são LINHAS numa tabela
 * (`KanbanColumn.name`), então o que chega aqui é o nome da coluna em
 * português, com acento e espaço — "Aguardando retirada", não
 * "aguardando_retirada".
 *
 * Isso importava mais do que parecia: os cenários de cobrança comparavam
 * contra 'pronto', 'entregue' e 'orcamento_enviado', que NÃO EXISTEM
 * naquele sistema. Ligar a integração sem este mapa daria zero mensagem,
 * sem nenhum erro — as 57 máquinas paradas e os 9 orçamentos sem resposta
 * continuariam invisíveis.
 *
 * Aceita as duas formas (nome da coluna e o slug do docs/integracao-os.md),
 * porque o contrato original prometeu os slugs e alguém pode implementar
 * por ele.
 */

/** O que a situação da OS significa para o CRM. */
export type OsSituacao =
  /** OS aberta, máquina ainda NÃO chegou (fluxo de envio remoto). */
  | 'aguardando_recebimento'
  /** Máquina na bancada: diagnóstico, autorizado, em serviço, esperando peça. */
  | 'na_bancada'
  /** Orçamento enviado, esperando a resposta do cliente. → cobrança */
  | 'aguardando_cliente'
  /** Serviço terminado, cliente ainda não buscou. → cobrança */
  | 'pronto'
  /** Encerrada: pago e entregue. → pós-venda */
  | 'finalizada'
  /** Nome que não conhecemos. Não dispara nada e aparece no log. */
  | 'desconhecido'

/**
 * Tira acento, caixa e separadores para comparar. "Aguardando Retirada",
 * "aguardando retirada " e "AGUARDANDO_RETIRADA" viram a mesma chave.
 */
export function normalizeOsStatus(raw: unknown): string | null {
  const texto = String(raw ?? '').trim()
  if (!texto) return null
  return texto
    .toLowerCase()
    .normalize('NFD')
    // Escrito com \u… de propósito: marca combinante literal aqui não
    // sobrevive a copiar/colar entre editores e passaria a não casar nada,
    // em silêncio.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s\-_]+/g, '_')
}

/**
 * As colunas reais do kanban dele (prisma/seed.ts do oficina-info-sistema,
 * conferido em 08/08/2026) + os slugs do contrato + variações plausíveis.
 */
const MAPA: Record<string, OsSituacao> = {
  // Coluna 0 — a máquina ainda está com o cliente.
  aguardando_recebimento: 'aguardando_recebimento',
  a_receber: 'aguardando_recebimento',
  os_criada: 'aguardando_recebimento',

  // Máquina na bancada.
  orcamento_a_fazer: 'na_bancada',
  em_levantamento: 'na_bancada',
  revisoes: 'na_bancada',
  enviar_orcamento: 'na_bancada',
  autorizado: 'na_bancada',
  em_servico: 'na_bancada',
  aguardando_peca: 'na_bancada',
  em_analise: 'na_bancada',
  em_reparo: 'na_bancada',

  // Bola na quadra do cliente — é aqui que mora a cobrança de orçamento.
  aguardando_cliente: 'aguardando_cliente',
  orcamento_enviado: 'aguardando_cliente',
  aguardando_aprovacao: 'aguardando_cliente',

  // Pronta. "Aguardando retirada" é a coluna que mais enche na loja.
  pronto_para_entrega: 'pronto',
  aguardando_retirada: 'pronto',
  pronto: 'pronto',
  pronta: 'pronto',

  // Encerrada.
  finalizada: 'finalizada',
  entregue: 'finalizada',
  concluida: 'finalizada',
}

/** Traduz o status cru da OS para a situação que o CRM entende. */
export function mapOsSituacao(raw: unknown): OsSituacao {
  const chave = normalizeOsStatus(raw)
  if (!chave) return 'desconhecido'
  return MAPA[chave] ?? 'desconhecido'
}

/**
 * A máquina já está na loja? Só quem sabe é o sistema de OS.
 * Desconhecido devolve `false` de propósito: marcar "chegou" cedo demais
 * tira o card da fila de cobrança justamente quando ele ainda precisa ser
 * cobrado. Um nome novo de coluna aparece no log e a gente mapeia.
 */
export function maquinaChegou(raw: unknown): boolean {
  const situacao = mapOsSituacao(raw)
  if (situacao === 'desconhecido') {
    console.warn(`[os] status não mapeado: ${JSON.stringify(raw)}`)
    return false
  }
  return situacao !== 'aguardando_recebimento'
}
