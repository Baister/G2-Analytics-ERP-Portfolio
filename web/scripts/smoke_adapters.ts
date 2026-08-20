// Smoke dos adaptadores contra os retratos reais da API.
//
//   npx tsx scripts/smoke_adapters.ts
//
// Roda cada adaptador com o payload que a API de fato devolve (public/demo/*.json,
// gerado por `python -m dados.exportar_demo`) e verifica o que quebraria a tela
// sem quebrar a compilação:
//
//   1. o adaptador não lança;
//   2. nenhum número do contrato é NaN ou Infinity — um NaN atravessa o
//      TypeScript sem reclamar e só aparece como gráfico vazio no navegador;
//   3. os arrays que a tela percorre existem e não vieram vazios;
//   4. nenhum texto tem espaço sobrando nas pontas;
//   5. as regras posicionais que a interface assume (duas fatias na rosca de
//      títulos, três etapas no funil, três classes na curva ABC).
//
// É o teste que a tipagem não faz: TypeScript garante o formato, não o conteúdo.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { adaptDashboard } from "../src/lib/api/adapters/dashboard";
import { adaptVendas } from "../src/lib/api/adapters/vendas";
import { adaptEstoque } from "../src/lib/api/adapters/estoque";
import { adaptFinanceiro } from "../src/lib/api/adapters/financeiro";
import { adaptCrm } from "../src/lib/api/adapters/crm";
import { adaptImposto } from "../src/lib/api/adapters/imposto";
import { adaptClientesCarteira } from "../src/lib/api/adapters/clientes";
import { adaptClientePerfil, adaptClientesBusca } from "../src/lib/api/adapters/cliente";
import { adaptPainelPedidos } from "../src/lib/api/adapters/painel";
import { adaptCmp } from "../src/lib/api/adapters/cmp";
import { adaptMetas } from "../src/lib/api/adapters/metas";
import type { Filtros } from "../src/lib/api/types";

const DEMO = join(import.meta.dirname, "..", "public", "demo");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const carregar = (nome: string): any =>
  JSON.parse(readFileSync(join(DEMO, `${nome}.json`), "utf8"));

const filtros = (): Filtros => ({
  vendedores: [],
  marcas: [],
  grupos: [],
  periodo: { inicio: "2026-01-01", fim: "2026-12-31" },
});

let falhas = 0;

/** Sentinelas legítimas: o contrato usa null para "ainda não há dado". */
const NULO_PERMITIDO = /\.(acumulado|meta)$/;

function naoFinitos(obj: unknown, caminho: string, achados: string[]): void {
  if (typeof obj === "number") {
    if (!Number.isFinite(obj)) achados.push(caminho);
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => naoFinitos(v, `${caminho}[${i}]`, achados));
    return;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (v === null && NULO_PERMITIDO.test(`${caminho}.${k}`)) continue;
      naoFinitos(v, `${caminho}.${k}`, achados);
    }
  }
}

function textoSujo(obj: unknown, caminho: string, achados: string[]): void {
  if (typeof obj === "string") {
    if (obj !== obj.trim()) achados.push(caminho);
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => textoSujo(v, `${caminho}[${i}]`, achados));
    return;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) textoSujo(v, `${caminho}.${k}`, achados);
  }
}

interface Caso {
  nome: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  roda: () => any;
  /** caminhos que precisam ser array não vazio */
  listas?: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra?: (r: any, erros: string[]) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function em(obj: any, caminho: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return caminho.split(".").reduce((o: any, p) => (o == null ? o : o[p]), obj);
}

function rodar(caso: Caso): void {
  const erros: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let r: any;
  try {
    r = caso.roda();
  } catch (e) {
    falhas++;
    console.log(`FALHOU  ${caso.nome}`);
    console.log(`        lançou: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  for (const lista of caso.listas ?? []) {
    const v = em(r, lista);
    if (!Array.isArray(v)) erros.push(`${lista} não é array`);
    else if (v.length === 0) erros.push(`${lista} veio vazio`);
  }

  const nf: string[] = [];
  naoFinitos(r, "$", nf);
  for (const p of nf.slice(0, 8)) erros.push(`número não finito em ${p}`);

  const sujo: string[] = [];
  textoSujo(r, "$", sujo);
  for (const p of sujo.slice(0, 5)) erros.push(`texto com espaço nas pontas em ${p}`);

  caso.extra?.(r, erros);

  if (erros.length) {
    falhas++;
    console.log(`FALHOU  ${caso.nome}`);
    for (const e of erros) console.log(`        - ${e}`);
  } else {
    console.log(`OK      ${caso.nome}`);
  }
}

const dash = carregar("dados-dashboard");
const vendas = carregar("dados-vendas");
const metas = carregar("metas");
const cli = carregar("dados-cliente");

const casos: Caso[] = [
  {
    nome: "adaptDashboard",
    roda: () => adaptDashboard(dash, vendas, filtros(), metas),
    listas: ["diario", "topVendedores", "porMarca", "porGrupo", "vendedores", "marcas", "grupos"],
    extra: (r, erros) => {
      if (!r.mesReferencia) erros.push("mesReferencia vazio");
      const soma = (l: { vendaLiquida: number }[]) => l.reduce((s, x) => s + x.vendaLiquida, 0);
      const marca = soma(r.porMarca);
      const grupo = soma(r.porGrupo);
      // Marca e grupo particionam o MESMO faturamento.
      if (Math.abs(marca - grupo) > Math.max(1, marca * 0.01)) {
        erros.push("porMarca e porGrupo não somam o mesmo total");
      }
      if (!(r.resultado.faturamentoLiquido > 0)) erros.push("faturamento líquido não positivo");
      if (!(r.performance.margemBruta > 0 && r.performance.margemBruta < 100)) {
        erros.push(`margem fora da faixa: ${r.performance.margemBruta}`);
      }
    },
  },
  {
    nome: "adaptVendas",
    roda: () => adaptVendas(vendas, metas, filtros()),
    listas: ["ritmo", "topVendedores", "topItens", "topMarcas", "progressoVendedores",
             "progressoDiarioVendedores", "vendedores", "marcas"],
    extra: (r, erros) => {
      const comDado = r.ritmo.filter((l: { acumulado: number | null }) => l.acumulado != null);
      if (!comDado.length) erros.push("ritmo sem nenhum dia com acumulado");
      const vals = comDado.map((l: { acumulado: number }) => l.acumulado);
      for (let i = 1; i < vals.length; i++) {
        if (vals[i] < vals[i - 1]) {
          erros.push("ritmo acumulado não é monotônico");
          break;
        }
      }
    },
  },
  {
    nome: "adaptEstoque",
    roda: () => adaptEstoque(carregar("dados-estoque")),
    listas: ["abc", "valorPorMarca", "evolucao", "itens"],
    extra: (r, erros) => {
      const classes = r.abc.map((c: { classe: string }) => c.classe).join("");
      if (classes !== "ABC") erros.push(`curva ABC fora de ordem: ${classes}`);
      if (!(r.kpis.valorEstoque > 0)) erros.push("valor de estoque não positivo");
    },
  },
  {
    nome: "adaptFinanceiro",
    roda: () => adaptFinanceiro(carregar("dados-financeiro")),
    listas: ["statusTitulos", "vencimentos", "foco", "limites"],
    extra: (r, erros) => {
      const nomes = r.statusTitulos.map((s: { nome: string }) => s.nome);
      if (nomes.join("|") !== "A Vencer|Vencido") {
        erros.push(`rosca de títulos com fatias erradas: ${nomes.join(", ")}`);
      }
      if (r.foco.length !== 2) erros.push("foco precisa de Boleto e Cartão");
      if (!(r.kpis.inadimplencia >= 0 && r.kpis.inadimplencia <= 100)) {
        erros.push(`inadimplência fora de 0-100: ${r.kpis.inadimplencia}`);
      }
    },
  },
  {
    nome: "adaptCrm (sem filtro)",
    roda: () => adaptCrm(carregar("dados-crm"), [], metas),
    listas: ["vendedores", "funil", "semanal", "ranking", "oportunidades",
             "topClientes", "histogramaInatividade"],
    extra: (r, erros) => {
      if (r.funil.length !== 3) erros.push(`funil com ${r.funil.length} etapas (esperado 3)`);
      if (!(r.kpis.taxaConversao >= 0 && r.kpis.taxaConversao <= 100)) {
        erros.push(`taxa de conversão fora de 0-100: ${r.kpis.taxaConversao}`);
      }
    },
  },
  {
    nome: "adaptCrm (1 vendedor do payload)",
    roda: () => {
      const bruto = carregar("dados-crm");
      const alvo = adaptCrm(bruto, [], metas).ranking[0]?.vendedor ?? "";
      return { ...adaptCrm(bruto, [alvo], metas), __alvo: alvo };
    },
    extra: (r, erros) => {
      if (!r.__alvo) {
        erros.push("ranking vazio — não deu para testar o filtro");
        return;
      }
      const fora = r.ranking.filter((l: { vendedor: string }) => l.vendedor.trim() !== r.__alvo);
      if (fora.length) erros.push(`${fora.length} linha(s) de outro vendedor no ranking`);
      if (!r.ranking.length) erros.push("filtro recortou tudo — caso vácuo");
    },
  },
  {
    nome: "adaptImposto",
    roda: () => adaptImposto(carregar("dados-imposto")),
    listas: ["diario", "evolucao", "cfops", "cfopEvolucao", "maioresNfs",
             "situacoes", "itensTributacao"],
    extra: (r, erros) => {
      if (!(r.kpis.aliquotaEfetiva >= 0 && r.kpis.aliquotaEfetiva <= 30)) {
        erros.push(`alíquota efetiva implausível: ${r.kpis.aliquotaEfetiva}`);
      }
    },
  },
  {
    nome: "adaptClientesCarteira",
    roda: () => adaptClientesCarteira(carregar("dados-clientes")),
    listas: ["segmentacao", "abc", "ativosPorMes", "top50"],
    extra: (r, erros) => {
      const classes = r.abc.map((c: { classe: string }) => c.classe).join("");
      if (classes !== "ABC") erros.push(`curva ABC fora de ordem: ${classes}`);
      if (r.top50.some((c: { codigo: string }) => !c.codigo)) {
        erros.push("cliente sem código no top 50");
      }
    },
  },
  {
    nome: "adaptClientesBusca",
    roda: () => adaptClientesBusca({ modo: "busca", clientes: cli.lista.slice(0, 20) }),
    extra: (r, erros) => {
      if (!Array.isArray(r) || !r.length) erros.push("busca não devolveu lista");
      else if (!r[0].codigo || !r[0].nome) erros.push("resultado de busca sem código/nome");
    },
  },
  {
    nome: "adaptClientePerfil",
    roda: () => adaptClientePerfil(cli.perfis[cli.destaques[0]]),
    listas: ["evolucao", "topProdutos", "marcas", "compras"],
    extra: (r, erros) => {
      if (!r.codigo) erros.push("perfil sem código no primeiro nível (o contrato é achatado)");
      if (!["Ativo", "Atenção", "Em risco", "Inativo"].includes(r.situacao)) {
        erros.push(`situação inesperada: ${r.situacao}`);
      }
      if (!(r.kpis.totalComprado > 0)) erros.push("total comprado não positivo");
    },
  },
  {
    nome: "adaptPainelPedidos",
    roda: () => adaptPainelPedidos(carregar("dados-painel-pedidos")),
    listas: ["resumo"],
    extra: (r, erros) => {
      const todos = [...r.aguardandoFaturamento, ...r.aguardandoConferencia, ...r.saiuHoje];
      if (!todos.length) erros.push("nenhum pedido nas três filas");
      for (const p of todos) {
        if (!p.pedido) erros.push("pedido sem identificador (é a chave do React)");
        if (!["retira", "rota"].includes(p.logistica?.tipo)) {
          erros.push(`logística inválida: ${p.logistica?.tipo}`);
        }
      }
      // O telão filtra por registroISO + registroHora: sem eles a tela fica vazia.
      if (todos.length && !todos[0].registroISO) erros.push("pedido sem registroISO");
      if (todos.length && !todos[0].registroHora) erros.push("pedido sem registroHora");
    },
  },
  {
    nome: "adaptCmp",
    roda: () => adaptCmp(carregar("dados-cliente-marca-produto")),
    listas: ["porCliente", "porMarca", "marcaQuantidade", "porItem",
             "clientes", "vendedores", "marcas"],
    extra: (r, erros) => {
      if (r.marcaQuantidade.length !== r.porMarca.length) {
        erros.push("marcaQuantidade não espelha porMarca");
      }
      if (!(r.kpis.vendaLiquida > 0)) erros.push("venda líquida não positiva");
      const somaTop = r.porCliente.reduce(
        (s: number, l: { vendaLiquida: number }) => s + l.vendaLiquida, 0);
      if (somaTop > r.kpis.vendaLiquida * 1.001) {
        erros.push("soma do top de clientes maior que o total — o KPI veio do top, não do conjunto");
      }
    },
  },
  {
    nome: "adaptMetas",
    roda: () => adaptMetas(metas, vendas),
    extra: (r, erros) => {
      if (!(r.metaEmpresa > 0)) erros.push("meta da empresa não positiva");
      if (!Array.isArray(r.metasVendedores) || !r.metasVendedores.length) {
        erros.push("sem metas individuais");
      }
    },
  },
];

console.log(`Retratos: ${DEMO}\n`);
for (const caso of casos) rodar(caso);

if (falhas) {
  console.log(`\n${falhas} caso(s) FALHARAM.`);
  process.exit(1);
}
console.log(`\nTodos os ${casos.length} casos passaram.`);
