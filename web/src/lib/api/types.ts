// Contratos de dados por aba. Um payload por tela — a API real deve devolver
// exatamente estas formas para que as telas não precisem mudar.

export interface Kpi {
  label: string;
  value: number;
  format: "brl" | "num" | "pct" | "text";
  hint?: string;
  tone?: "primary" | "success" | "danger" | "warning" | "accent";
  text?: string;
}

export interface SerieDia {
  dia: number;
  data: string;
  valor: number;
}

export interface Vendedor {
  id: string;
  nome: string;
}

export interface Marca {
  id: string;
  nome: string;
}

export interface Grupo {
  id: string;
  nome: string;
}

/** Período de análise (datas ISO yyyy-mm-dd). */
export interface Periodo {
  inicio: string;
  fim: string;
}

/** Filtros multi-seleção comuns às abas analíticas. */
export interface Filtros {
  vendedores: string[];
  marcas: string[];
  grupos: string[];
  periodo: Periodo;
}

/** Uma fatia analítica (marca ou grupo). */
export interface DimensaoValor {
  nome: string;
  vendaLiquida: number;
  custoReposicao: number;
  lucroBruto: number;
  margem: number;
  quantidade: number;
}


export interface RankVendedor {
  vendedor: string;
  valor: number;
  ticket: number;
  documentos: number;
}

export interface DashboardData {
  mesReferencia: string;
  vendedores: Vendedor[];
  marcas: Marca[];
  grupos: Grupo[];
  resultado: {
    faturamentoBruto: number;
    devolucoes: number;
    documentosCancelados: number;
    faturamentoLiquido: number;
    qtdVendas: number;
    qtdDevolucoes: number;
    lucroBruto: number;
    custoReposicao: number;
  };
  performance: {
    percentualMeta: number;
    metaDoDia: number;
    margemBruta: number;
    ticketMedio: number;
    frete: number;
  };
  diario: SerieDia[];
  topVendedores: RankVendedor[];
  porMarca: DimensaoValor[];
  porGrupo: DimensaoValor[];
}

export interface ItemRank {
  codigo: string;
  descricao: string;
  marca: string;
  quantidade: number;
  valor: number;
}

export interface ProgressoVendedor {
  vendedor: string;
  realizado: number;
  meta: number;
  percentual: number;
}

export interface ProgressoDia {
  dia: number;
  data: string;
  metaDia: number;
  realizado: number;
  percentual: number;
}

export interface VendasData {
  kpis: {
    faturamentoBruto: number;
    devolucaoValor: number;
    margemBruta: number;
    ticketMedio: number;
    documentos: number;
    devolucoes: number;
    clientesAtivos: number;
    totalMarcas: number;
  };
  ritmo: { dia: number; acumulado: number; meta: number }[];
  vendedores: Vendedor[];
  marcas: Marca[];
  topVendedores: RankVendedor[];
  topItens: ItemRank[];
  topMarcas: { marca: string; valor: number; documentos: number }[];
  progressoVendedores: ProgressoVendedor[];
  /** Meta do DIA por vendedor: vendido hoje × (restante da meta ÷ dias úteis
   * restantes) — visão do painel "Progresso Diário" (porte do front antigo). */
  progressoDiarioVendedores: ProgressoVendedor[];
  progressoDiario: ProgressoDia[];
}


export interface EstoqueItem {
  codigo: string;
  descricao: string;
  marca: string;
  quantidade: number;
  disponivel: number;
  diasSemVenda: number;
  custo: number;
  valor: number;
  classe: "A" | "B" | "C";
}

export interface EstoqueData {
  kpis: {
    valorEstoque: number;
    qtdEstoque: number;
    skus: number;
    abaixoMinimo: number;
    semEstoque: number;
    estoqueParado: number;
    coberturaMedia: number;
  };
  abc: { classe: "A" | "B" | "C"; itens: number; percentualVendas: number; valorEstoque: number }[];
  valorPorMarca: { marca: string; valor: number }[];
  evolucao: { mes: string; valor: number; quantidade: number }[];
  itens: EstoqueItem[];
}

export interface TituloVencimento {
  data: string;
  dia: number;
  valor: number;
  situacao: "atrasado" | "proximo" | "futuro";
  clientes: { cliente: string; documento: string; valor: number }[];
}

export interface FocoLinha {
  cliente: string;
  documento: string;
  dias: number;
  valor: number;
}

export interface FinanceiroData {
  kpis: {
    aReceberQtd: number;
    aReceberValor: number;
    vencidos: number;
    aVencer: number;
    recebidoMes: number;
    inadimplencia: number;
    /** Contagens de títulos (cards exibem quantidade, não R$ — 2026-08-13). */
    vencidosQtd: number;
    aVencerQtd: number;
    recebidoMesQtd: number;
  };
  /** Donut A Vencer × Vencido — o gráfico exibe QUANTIDADE de títulos
   * (decisão 2026-08-18); o valor em R$ segue disponível p/ Excel. */
  statusTitulos: { nome: string; valor: number; quantidade: number }[];
  vencimentos: TituloVencimento[];
  foco: {
    tipo: "Boleto" | "Cartão";
    emAberto: number;
    vencidos: number;
    aVencer30: number;
    recebidoMes: number;
    badge: string;
    clientes: FocoLinha[];
  }[];
  limites: {
    codigo: string;
    cliente: string;
    limite: number;
    utilizado: number;
    utilizacao: number;
  }[];
}

export interface CrmData {
  vendedores: Vendedor[];
  kpis: {
    taxaConversao: number;
    pipeline: number;
    faturadoMes: number;
    propostasCaixa: number;
    clientesAtivos: number;
    clientesNovos: number;
    emRisco: number;
    inativos: number;
  };
  funil: { etapa: string; valor: number; percentual: number }[];
  semanal: { semana: string; propostas: number; convertidos: number }[];
  ranking: {
    vendedor: string;
    propostas: number;
    conversoes: number;
    taxa: number;
    valor: number;
    ticket: number;
    cancelados: number;
    percentualMeta: number;
  }[];
  oportunidades: {
    numero: string;
    cliente: string;
    vendedor: string;
    data: string;
    diasAberto: number;
    valor: number;
  }[];
  topClientes: { codigo: string; cliente: string; valor: number }[];
  clientesNovos: { codigo: string; cliente: string; data: string; valor: number }[];
  histogramaInatividade: { faixa: string; clientes: number }[];
  emRisco: { cliente: string; vendedor: string; dias: number; valor: number }[];
  inativos: { cliente: string; ultimoVendedor: string; dias: number; historico: number }[];
}

export interface ImpostoData {
  kpis: {
    icmsMes: number;
    aliquotaEfetiva: number;
    projecaoIcms: number;
    baseCalculo: number;
    faturamentoNfs: number;
    qtdeNfs: number;
    stOutras: number;
    isentasIcms: number;
    icmsStDestacado: number;
    ipiDebitado: number;
    isentasIpi: number;
    frete: number;
  };
  diario: { dia: number; icms: number }[];
  evolucao: { mes: string; icms: number; st: number; ipi: number; aliquota: number }[];
  cfops: { cfop: string; descricao: string; valor: number; icms: number; dentroEstado: boolean }[];
  cfopEvolucao: { mes: string; dentro: number; fora: number }[];
  maioresNfs: { nf: string; cliente: string; data: string; valor: number; icms: number }[];
  situacoes: { nome: string; valor: number }[];
  regrasPisCofins: { regra: string; itens: number; valor: number }[];
  itensTributacao: {
    codigo: string;
    descricao: string;
    cst: string;
    ncm: string;
    aliquota: number;
    valor: number;
  }[];
}

export interface ClienteResumo {
  codigo: string;
  nome: string;
  razao: string;
  cnpj: string;
  cidade: string;
  uf: string;
}

export interface ClientePerfil extends ClienteResumo {
  situacao: "Ativo" | "Atenção" | "Em risco" | "Inativo";
  diasUltimaCompra: number;
  limiteCredito: number;
  limiteUtilizado: number;
  kpis: {
    totalComprado: number;
    pedidos: number;
    ticket: number;
    devolucoes: number;
    ultimaCompra: string;
    frequenciaDias: number;
  };
  evolucao: { mes: string; valor: number }[];
  topProdutos: { descricao: string; quantidade: number; valor: number }[];
  marcas: { marca: string; valor: number }[];
  vendedores: { vendedor: string; periodo: string; atual: boolean }[];
  compras: { documento: string; data: string; valor: number; devolucao: boolean }[];
  orcamentos: { numero: string; data: string; dias: number; valor: number }[];
  titulos: { documento: string; vencimento: string; valor: number; vencido: boolean }[];
}

export interface ClientesCarteira {
  kpis: {
    compradores12m: number;
    ativosMes: number;
    novosMes: number;
    receita12m: number;
    ticketMedio: number;
    concentracaoTop10: number;
  };
  segmentacao: { faixa: string; clientes: number }[];
  abc: { classe: "A" | "B" | "C"; clientes: number; receita: number; percentual: number }[];
  ativosPorMes: { mes: string; ativos: number }[];
  top50: {
    codigo: string;
    cliente: string;
    abc: "A" | "B" | "C";
    receita: number;
    pedidos: number;
    ticket: number;
    ultimaCompra: string;
    recencia: "Ativo" | "Atenção" | "Em risco" | "Inativo";
  }[];
}

export interface Pedido {
  pedido: string;
  razaoSocial: string;
  vendedor: string;
  emissao: string;
  entrega: string;
  entregaVencida: boolean;
  logistica: { tipo: "retira" | "rota"; nome: string };
  valor: number;
  horasFila: number;
  nf?: string;
  hora?: string;
  /** Data de registro do pedido (YYYY-MM-DD). */
  registroISO?: string;
  /** Hora aproximada do registro (HH:MM) — primeiro rastro do pedido no dia:
   * min(primeiro evento do log, DtHrEdit). O ERP não guarda hora de criação. */
  registroHora?: string;
}

export interface PainelPedidos {
  resumo: { status: string; pedidos: number; valor: number }[];
  aguardandoFaturamento: Pedido[];
  aguardandoConferencia: Pedido[];
  saiuHoje: Pedido[];
}

export interface MetasConfig {
  metaEmpresa: number;
  metasVendedores: { vendedor: string; meta: number }[];
}

/** Filtros da aba Cliente × Marca × Produto. */
export interface CmpFiltros {
  periodo: Periodo;
  /** Códigos de cliente (CodCli ≡ CodRedCt). */
  clientes: string[];
  /** Códigos de vendedor (CodVend — vendedor do DOCUMENTO). */
  vendedores: string[];
  /** Nomes de marca (DescrMarca). */
  marcas: string[];
}

export interface CmpKpis {
  margemLucro: number;
  ticketMedioProduto: number;
  /** COUNT DISTINCT de documentos de venda (líquida). */
  qtdeVendasLiq: number;
  vendaLiquida: number;
  /** Devoluções em R$ (item-level — respeita todos os filtros). */
  devolucao: number;
  /** Frete doc-level — NÃO recorta por marca (TotalFrete é do documento). */
  frete: number;
}

export interface CmpData {
  kpis: CmpKpis;
  porCliente: {
    codigo: string;
    cliente: string;
    vendaLiquida: number;
    margemLucroBruto: number;
    quantidade: number;
    ticketMedioProduto: number;
  }[];
  porMarca: {
    marca: string;
    vendaLiquida: number;
    custoReposicaoLiq: number;
    margem: number;
    quantidade: number;
    ticketMedio: number;
  }[];
  marcaQuantidade: { marca: string; quantidade: number }[];
  porItem: {
    codigo: string;
    item: string;
    vendaLiquida: number;
    quantidade: number;
    margem: number;
    marca: string;
  }[];
  clientes: { codigo: string; nome: string }[];
  vendedores: { codigo: string; nome: string }[];
  marcas: { nome: string }[];
}
