// Smoke test dos adaptadores contra payloads REAIS dos bots.
//
// Uso: npx -y tsx scripts/smoke_adapters.ts <dir-com-fixtures>
//   O diretório deve conter dashboard.json, vendas.json, estoque.json,
//   financeiro.json, crm.json, imposto.json e cliente_comportamento.json
//   (payloads crus de GET /dados/<bot>). Os fixtures ficam FORA do repo
//   (dados reais de produção — o repo é público); este script só recebe o
//   caminho por argumento e nunca embute dados.
//
// Asserções por adaptador:
//   1. não lança com o payload real;
//   2. KPIs principais são números finitos (nada de NaN/Infinity);
//   3. os arrays esperados pelo contrato existem;
//   4. nenhuma string do resultado tem espaço à direita (nomes de vendedor
//      vêm do banco com padding — o front só pode ver nomes com trim).
//
// Saída de falha imprime apenas CAMINHOS de campos, nunca valores reais.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { adaptDashboard } from "../src/lib/api/adapters/dashboard";
import { adaptVendas } from "../src/lib/api/adapters/vendas";
import { adaptFinanceiro } from "../src/lib/api/adapters/financeiro";
import { adaptCrm } from "../src/lib/api/adapters/crm";
import { adaptEstoque } from "../src/lib/api/adapters/estoque";
import { adaptImposto } from "../src/lib/api/adapters/imposto";
import { adaptClientesCarteira } from "../src/lib/api/adapters/clientes";
import { adaptCmp } from "../src/lib/api/adapters/cmp";
import type { Filtros } from "../src/lib/api/types";

// ── Infra ────────────────────────────────────────────────────────────────────

const fixturesDir = process.argv[2];
if (!fixturesDir) {
  console.error("Uso: npx tsx scripts/smoke_adapters.ts <dir-com-fixtures>");
  process.exit(2);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadFixture(nome: string): any {
  return JSON.parse(readFileSync(join(fixturesDir, `${nome}.json`), "utf8"));
}

const filtrosVazios = (): Filtros => ({
  vendedores: [],
  marcas: [],
  grupos: [],
  periodo: { inicio: "2026-08-01", fim: "2026-08-31" },
});

let falhas = 0;

// Sentinelas NaN DOCUMENTADOS (vendas.ts calculaRitmo): acumulado NaN após o
// último dia com dado (a linha para no gráfico) e meta NaN quando não há meta
// configurada (a linha de meta some). São design, não defeito.
const NAN_PERMITIDO = /^\$\.ritmo\[\d+\]\.(acumulado|meta)$/;

/** Coleta caminhos de todo número NÃO finito dentro de `obj`. */
function numerosNaoFinitos(obj: unknown, path: string, out: string[]): void {
  if (typeof obj === "number") {
    if (!Number.isFinite(obj) && !NAN_PERMITIDO.test(path)) out.push(path);
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => numerosNaoFinitos(v, `${path}[${i}]`, out));
    return;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) numerosNaoFinitos(v, `${path}.${k}`, out);
  }
}

/** Coleta caminhos de strings com espaço à direita (nomes sem trim). */
function stringsComEspacoFinal(obj: unknown, path: string, out: string[]): void {
  if (typeof obj === "string") {
    if (/ +$/.test(obj)) out.push(path);
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => stringsComEspacoFinal(v, `${path}[${i}]`, out));
    return;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) stringsComEspacoFinal(v, `${path}.${k}`, out);
  }
}

interface Caso {
  nome: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  roda: () => any;
  /** Campos de KPI (objeto só de números) que devem existir e ser finitos. */
  kpisEm: string[];
  /** Campos que devem ser arrays. */
  arrays: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extras?: (resultado: any, erros: string[]) => void;
}

function caminho(obj: unknown, path: string): unknown {
  let atual: unknown = obj;
  for (const parte of path.split(".")) {
    if (!atual || typeof atual !== "object") return undefined;
    atual = (atual as Record<string, unknown>)[parte];
  }
  return atual;
}

function rodaCaso(caso: Caso): void {
  const erros: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resultado: any;
  try {
    resultado = caso.roda();
  } catch (e) {
    falhas++;
    console.log(`FALHOU  ${caso.nome}`);
    console.log(`        lançou: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  // KPIs: existem e todo número dentro deles é finito
  for (const kpiPath of caso.kpisEm) {
    const kpiObj = caminho(resultado, kpiPath);
    if (!kpiObj || typeof kpiObj !== "object") {
      erros.push(`${kpiPath} ausente ou não é objeto`);
      continue;
    }
    const naoFinitos: string[] = [];
    numerosNaoFinitos(kpiObj, kpiPath, naoFinitos);
    for (const p of naoFinitos) erros.push(`número não finito em ${p}`);
    const numericos = Object.values(kpiObj).filter((v) => typeof v === "number");
    if (numericos.length === 0) erros.push(`${kpiPath} não tem nenhum campo numérico`);
  }

  // Arrays esperados
  for (const arrPath of caso.arrays) {
    if (!Array.isArray(caminho(resultado, arrPath))) erros.push(`${arrPath} não é array`);
  }

  // Números não finitos em QUALQUER lugar do resultado
  const naoFinitosGeral: string[] = [];
  numerosNaoFinitos(resultado, "$", naoFinitosGeral);
  for (const p of naoFinitosGeral.slice(0, 10)) erros.push(`número não finito em ${p}`);

  // Strings com espaço à direita em qualquer lugar
  const comEspaco: string[] = [];
  stringsComEspacoFinal(resultado, "$", comEspaco);
  for (const p of comEspaco.slice(0, 10)) erros.push(`string com espaço à direita em ${p}`);

  caso.extras?.(resultado, erros);

  if (erros.length) {
    falhas++;
    console.log(`FALHOU  ${caso.nome}`);
    for (const e of erros) console.log(`        - ${e}`);
  } else {
    console.log(`OK      ${caso.nome}`);
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const fxDashboard = loadFixture("dashboard");
const fxVendas = loadFixture("vendas");
const fxEstoque = loadFixture("estoque");
const fxFinanceiro = loadFixture("financeiro");
const fxCrm = loadFixture("crm");
const fxImposto = loadFixture("imposto");
const fxCliCarteira = loadFixture("cliente_comportamento");

// cmp.json é opcional (payload on-demand de GET /dados/cliente-marca-produto,
// capturado com o hub no ar) — sem ele o caso é pulado com aviso.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fxCmp: any = null;
try {
  fxCmp = loadFixture("cmp");
} catch {
  console.log("AVISO   cmp.json ausente — caso adaptCmp pulado.");
}

// Um vendedor REAL vindo do próprio payload (com trim — o front só vê nomes limpos).
const vendedorReal: string = String(
  fxDashboard?.kpis_por_vendedor?.[0]?.Vendedor ?? fxDashboard?.top_vendedores?.[0]?.Vendedor ?? "",
).trim();
if (!vendedorReal) {
  console.error("Fixture dashboard.json sem vendedor em kpis_por_vendedor/top_vendedores.");
  process.exit(2);
}
// Não imprime o nome real (dados de produção) — só evidência mascarada.
console.log(
  `Vendedor real extraído do payload: "${vendedorReal[0]}${"*".repeat(vendedorReal.length - 1)}" (${vendedorReal.length} chars)`,
);

// Vendedor do payload do CRM — sai do próprio fixture (nenhum nome real é
// escrito neste arquivo). ranking_vendedores pode vir [] em run degradado do
// bot, por isso a busca cai para as outras listas com dimensão de vendedor.
const vendedorCrm: string = String(
  fxCrm?.ranking_vendedores?.[0]?.Vendedor ??
    fxCrm?.cancelados_por_vendedor?.[0]?.Vendedor ??
    fxCrm?.orc_abertos_lista?.[0]?.vendedor ??
    fxCrm?.top_clientes?.[0]?.vendedor ??
    "",
).trim();
if (!vendedorCrm) {
  console.error("Fixture crm.json sem vendedor em nenhuma lista com essa dimensão.");
  process.exit(2);
}

// ── Casos ────────────────────────────────────────────────────────────────────

const casos: Caso[] = [
  {
    nome: "adaptDashboard (filtros vazios)",
    roda: () => adaptDashboard(fxDashboard, fxVendas, filtrosVazios()),
    kpisEm: ["resultado", "performance"],
    arrays: [
      "vendedores",
      "marcas",
      "grupos",
      "diario",
      "topVendedores",
      "porMarca",
      "porGrupo",
    ],
    extras: (r, erros) => {
      if (typeof r.mesReferencia !== "string" || !r.mesReferencia) {
        erros.push("mesReferencia vazio");
      }
      if (!r.vendedores.length) erros.push("lista de vendedores veio vazia");
    },
  },
  {
    nome: "adaptDashboard (1 vendedor real)",
    roda: () =>
      adaptDashboard(fxDashboard, fxVendas, { ...filtrosVazios(), vendedores: [vendedorReal] }),
    kpisEm: ["resultado", "performance"],
    arrays: ["diario", "topVendedores", "porMarca"],
    extras: (r, erros) => {
      if (!(r.resultado.faturamentoBruto >= 0)) {
        erros.push("resultado.faturamentoBruto não é >= 0 com vendedor filtrado");
      }
    },
  },
  {
    nome: "adaptVendas (raw, null, filtros vazios)",
    roda: () => adaptVendas(fxVendas, null, filtrosVazios()),
    kpisEm: ["kpis"],
    arrays: [
      "ritmo",
      "vendedores",
      "marcas",
      "topVendedores",
      "topItens",
      "topMarcas",
      "progressoVendedores",
      "progressoDiario",
    ],
  },
  {
    nome: "adaptFinanceiro",
    roda: () => adaptFinanceiro(fxFinanceiro),
    kpisEm: ["kpis"],
    arrays: ["statusTitulos", "vencimentos", "foco", "limites"],
  },
  {
    nome: "adaptCrm (vendedores [])",
    roda: () => adaptCrm(fxCrm, []),
    kpisEm: ["kpis"],
    arrays: [
      "vendedores",
      "funil",
      "semanal",
      "ranking",
      "oportunidades",
      "topClientes",
      "clientesNovos",
      "histogramaInatividade",
      "emRisco",
      "inativos",
    ],
  },
  {
    nome: "adaptCrm (1 vendedor real do payload)",
    roda: () => adaptCrm(fxCrm, [vendedorCrm]),
    kpisEm: ["kpis"],
    arrays: ["ranking", "oportunidades", "emRisco", "inativos"],
    extras: (r, erros) => {
      // O filtro recorta as tabelas com dimensão de vendedor: toda linha
      // restante tem de ser do vendedor filtrado.
      const alvo = vendedorCrm.toLowerCase();
      const checa = (linhas: { vendedor: string }[], nome: string) => {
        for (const [i, linha] of linhas.entries()) {
          if (linha.vendedor.trim().toLowerCase() !== alvo) {
            erros.push(`${nome}[${i}] não é do vendedor filtrado`);
          }
        }
      };
      checa(r.ranking as { vendedor: string }[], "ranking");
      checa(r.oportunidades as { vendedor: string }[], "oportunidades");
      checa(r.emRisco as { vendedor: string }[], "emRisco");

      // Guarda contra caso vácuo: o filtro precisa ter sobrado linhas E ter
      // recortado alguma coisa em relação ao payload sem filtro.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const total = (x: any): number =>
        x.ranking.length + x.oportunidades.length + x.emRisco.length;
      if (total(r) === 0) erros.push("nenhuma linha sobreviveu ao filtro — caso vácuo");
      if (total(adaptCrm(fxCrm, [])) <= total(r)) {
        erros.push("o filtro de vendedor não recortou nada — caso vácuo");
      }
    },
  },
  {
    nome: "adaptEstoque",
    roda: () => adaptEstoque(fxEstoque),
    kpisEm: ["kpis"],
    arrays: ["abc", "valorPorMarca", "evolucao", "itens"],
  },
  {
    nome: "adaptImposto",
    roda: () => adaptImposto(fxImposto),
    kpisEm: ["kpis"],
    arrays: [
      "diario",
      "evolucao",
      "cfops",
      "cfopEvolucao",
      "maioresNfs",
      "situacoes",
      "regrasPisCofins",
      "itensTributacao",
    ],
  },
  {
    nome: "adaptClientesCarteira",
    roda: () => adaptClientesCarteira(fxCliCarteira),
    kpisEm: ["kpis"],
    arrays: ["segmentacao", "abc", "ativosPorMes", "top50"],
  },
];

if (fxCmp) {
  casos.push({
    nome: "adaptCmp",
    roda: () => adaptCmp(fxCmp),
    kpisEm: ["kpis"],
    arrays: ["porCliente", "porMarca", "marcaQuantidade", "porItem", "clientes", "vendedores", "marcas"],
    extras: (r, erros) => {
      // marcaQuantidade deriva de porMarca (mesmo tamanho e mesma ordem).
      if (r.marcaQuantidade.length !== r.porMarca.length) {
        erros.push("marcaQuantidade não espelha porMarca");
      }
      if (r.porCliente.length && !r.porCliente[0].codigo) {
        erros.push("porCliente[0].codigo vazio");
      }
    },
  });
}

console.log(`Fixtures: ${fixturesDir}`);
for (const caso of casos) rodaCaso(caso);

if (falhas) {
  console.log(`\n${falhas} caso(s) FALHARAM.`);
  process.exit(1);
}
console.log(`\nTodos os ${casos.length} casos passaram.`);
