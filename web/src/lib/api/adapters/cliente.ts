// Adaptador Cliente 360º — converte as DUAS respostas de GET /dados/cliente nos
// contratos que a tela consome: ClienteResumo[] (?busca=) e ClientePerfil
// (?cod=). Funções puras: entra o JSON da API, sai o contrato tipado.
//
// O servidor entrega o perfil já apurado — situação, dias desde a última
// compra, limite utilizado, KPIs de 12 meses e as listas prontas — num envelope
// com o cadastro isolado em `cliente`. Ao adaptador cabe ACHATAR esse bloco no
// primeiro nível do contrato, renomear os campos (snake_case → camelCase) e
// derivar o punhado de coisas que a tela pede e o payload não traz: o aging dos
// orçamentos, o flag de título vencido e o rótulo de mês do gráfico.
//
// Semântica de que a tela depende:
//   - situacao precisa bater EXATAMENTE com um dos quatro rótulos do contrato:
//     a badge do cabeçalho escolhe a cor por igualdade de string.
//   - compras[].devolucao pinta a linha de vermelho e a tela já prefixa "-" no
//     valor; por isso a devolução vai em MÓDULO — ela chega negativa no payload
//     e sem o módulo a tabela mostraria "- -R$ 100".
//   - titulos[].vencido sai da comparação com o campo `hoje` DO PAYLOAD, não do
//     relógio do navegador: o mesmo retrato precisa ler igual em qualquer
//     máquina e qualquer fuso.
//   - orcamentos[].dias é o aging em dias abertos: a badge fica amarela acima
//     de 30 e vermelha acima de 60.
//   - Todo campo numérico do contrato é number finito — num() blinda os nulos.
//
// Convenção: dentro de src/lib/api/** só imports RELATIVOS.

import type { ClientePerfil, ClienteResumo } from "../types";
import { clean, isoDate, num, pad2 } from "./shared";

// Linhas cruas do payload — shape validado contra o retrato da API, sem tipagem estática.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const asRows = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);

type Situacao = ClientePerfil["situacao"];

/** Rótulos aceitos pela badge de situação; qualquer outro vira "Inativo". */
const SITUACOES: readonly string[] = ["Ativo", "Atenção", "Em risco", "Inativo"];

/** Abreviações usadas nos eixos de mês do restante do app ("ago. 25"). */
const MESES_ABREV = [
  "jan.",
  "fev.",
  "mar.",
  "abr.",
  "mai.",
  "jun.",
  "jul.",
  "ago.",
  "set.",
  "out.",
  "nov.",
  "dez.",
];

/**
 * Situação pronta do servidor, apenas validada. A normalização NFC existe
 * porque o rótulo é comparado por igualdade de string: acento decomposto (NFD)
 * na origem produziria um texto visualmente idêntico que não casaria com
 * nenhum dos quatro valores do contrato.
 */
function situacaoDe(x: unknown): Situacao {
  const v = clean(x).normalize("NFC");
  return (SITUACOES.includes(v) ? v : "Inativo") as Situacao;
}

/** Data local 'YYYY-MM-DD' — só entra em cena se o payload vier sem `hoje`. */
function hojeISO(agora: Date): string {
  return `${agora.getFullYear()}-${pad2(agora.getMonth() + 1)}-${pad2(agora.getDate())}`;
}

/**
 * 'YYYY-MM' → 'ago. 25'. O eixo de meses deste gráfico é o único que chega cru
 * (as outras abas recebem o rótulo pronto), e "2025-08" repetido treze vezes
 * não cabe no eixo. Rótulo em outro formato passa intacto.
 */
function rotuloMes(x: unknown): string {
  const s = clean(x);
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  if (!m) return s;
  const abrev = MESES_ABREV[num(m[2]) - 1];
  return abrev ? `${abrev} ${clean(m[1]).slice(2)}` : s;
}

/**
 * Dias corridos entre duas datas 'YYYY-MM-DD'. A âncora é UTC de propósito:
 * em horário de verão o dia local tem 23h ou 25h e a divisão arredondaria um
 * dia a mais/menos no aging. Data ilegível → 0 (nunca NaN no contrato).
 */
function diasEntre(de: string, ate: string): number {
  const inicio = Date.parse(`${de}T00:00:00Z`);
  const fim = Date.parse(`${ate}T00:00:00Z`);
  if (!Number.isFinite(inicio) || !Number.isFinite(fim)) return 0;
  return Math.max(0, Math.round((fim - inicio) / 86400000));
}

// ── ?busca=TERMO → lista de candidatos ────────────────────────────────────────
export function adaptClientesBusca(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
): ClienteResumo[] {
  // A busca responde { clientes: [...] }; sem termo o servidor devolve um
  // envelope sem lista alguma — daí o fallback antes de mapear.
  const rows = asRows(raw?.clientes ?? raw?.lista ?? raw);
  return rows
    .map((r) => ({
      codigo: clean(r.codigo),
      nome: clean(r.nome) || clean(r.razao) || "—",
      razao: clean(r.razao),
      cnpj: clean(r.cnpj),
      cidade: clean(r.cidade),
      uf: clean(r.uf),
    }))
    .filter((c) => c.codigo); // sem código o card não tem como abrir o perfil
}

// ── ?cod=X → perfil 360º ──────────────────────────────────────────────────────
export function adaptClientePerfil(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
  agora: Date = new Date(),
): ClientePerfil {
  const d: Row = raw ?? {};
  // Código inexistente responde { erro }; o hook transforma o throw em estado
  // de erro da tela.
  if (d.erro) throw new Error(clean(d.erro));

  const c: Row = d.cliente ?? {}; // cadastro — achatado no contrato
  const k: Row = d.kpis ?? {};
  const hoje = isoDate(d.hoje) || hojeISO(agora);

  return {
    // Identificação (ClienteResumo) — sobe de `cliente` para o primeiro nível.
    codigo: clean(c.codigo),
    nome: clean(c.nome) || clean(c.razao) || "—",
    razao: clean(c.razao),
    cnpj: clean(c.cnpj),
    cidade: clean(c.cidade),
    uf: clean(c.uf),

    // Cabeçalho — situação e exposição de crédito, tudo apurado no servidor.
    situacao: situacaoDe(c.situacao),
    diasUltimaCompra: num(c.dias_ultima_compra),
    limiteCredito: num(c.limite_credito),
    limiteUtilizado: num(c.limite_utilizado),

    // KPIs de 12 meses — devoluções em módulo (o cartão é um valor absoluto,
    // a leitura de "quanto voltou" não muda de sinal).
    kpis: {
      totalComprado: num(k.total_comprado),
      pedidos: num(k.pedidos),
      ticket: num(k.ticket),
      devolucoes: Math.abs(num(k.devolucoes)),
      ultimaCompra: isoDate(k.ultima_compra),
      frequenciaDias: num(k.frequencia_dias),
    },

    // Evolução mensal (ordem do servidor preservada: mais antigo → mais novo).
    evolucao: asRows(d.evolucao).map((r) => ({
      mes: rotuloMes(r.mes),
      valor: num(r.valor),
    })),

    topProdutos: asRows(d.top_produtos).map((r) => ({
      descricao: clean(r.descricao) || "—",
      quantidade: num(r.quantidade),
      valor: num(r.valor),
    })),

    marcas: asRows(d.marcas).map((r) => ({
      marca: clean(r.marca) || "—",
      valor: num(r.valor),
    })),

    // Histórico de vendedores: o payload expõe só o vendedor ATUAL da carteira,
    // então a tabela tem uma linha e o período não é apurável — derivar um
    // intervalo da série de compras afirmaria algo que o dado não diz.
    vendedores: clean(c.vendedor)
      ? [{ vendedor: clean(c.vendedor), periodo: "carteira atual", atual: true }]
      : [],

    // Últimas compras — a devolução é um TIPO de documento no payload e vira
    // flag no contrato; valor em módulo (ver cabeçalho).
    compras: asRows(d.compras).map((r) => {
      const devolucao = clean(r.tipo).toLowerCase() === "devolucao";
      const valor = num(r.valor);
      return {
        documento: clean(r.documento),
        data: isoDate(r.data),
        valor: devolucao ? Math.abs(valor) : valor,
        devolucao,
      };
    }),

    // Orçamentos em aberto — o aging é derivado aqui: o payload dá a data de
    // emissão e a tela pede os dias em aberto.
    orcamentos: asRows(d.orcamentos).map((r) => {
      const data = isoDate(r.data);
      return {
        numero: clean(r.numero),
        data,
        dias: diasEntre(data, hoje),
        valor: num(r.valor),
      };
    }),

    // Títulos em aberto — datas ISO comparam lexicograficamente na ordem
    // cronológica, então basta a comparação de strings contra `hoje`.
    titulos: asRows(d.titulos).map((r) => {
      const vencimento = isoDate(r.vencimento);
      return {
        documento: clean(r.documento),
        vencimento,
        valor: num(r.valor),
        vencido: Boolean(vencimento) && vencimento < hoje,
      };
    }),
  };
}
