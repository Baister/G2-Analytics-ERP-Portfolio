// Adaptador Cliente 360º — converte as respostas de GET /dados/cliente no
// contrato ClienteResumo[] (?busca=) e ClientePerfil (?cod=) consumidos pela tela.
//
// Fonte dos shapes: hub/server.py (_cliente_buscar / _cliente_perfil) + front
// antigo (hub/frontend/src/pages/Cliente.jsx) — essas rotas são sob demanda e
// não têm fixture.
//
// Decisões portadas / documentadas:
//   - Situação por recência (mesmas faixas do front antigo): Ativo ≤30d,
//     Atenção ≤60d, Em risco ≤90d, Inativo +90d; sem data conhecida → Inativo.
//   - dias sem compra: KPI dos documentos (24m); fallback DtUltCmpCli do
//     cadastro quando o cliente não tem documento no período.
//   - limiteUtilizado: o servidor não expõe "crédito utilizado" — usamos a soma
//     dos títulos em aberto (titulos.valor), a leitura padrão de exposição.
//   - devoluções vêm com valor NEGATIVO no payload → exibidas em módulo
//     (o front antigo faz Math.abs; a tela nova prefixa "-" quando devolucao).
//   - cidade: o servidor só expõe UF (UFMunicFat) — cidade fica "" (Fase 2).
//   - raw.erro (cliente não encontrado) → throw Error com a mensagem do server.

import type { ClientePerfil, ClienteResumo } from "../types";
import { clean, isoDate, num, pad2 } from "./shared";

// Linhas cruas do payload — shape validado contra o server, sem tipagem estática.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const asRows = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);

/** Faixas de recência do projeto (iguais no perfil 360º e na carteira). */
export function situacaoPorDias(dias: number | null | undefined): ClientePerfil["situacao"] {
  if (dias == null || !Number.isFinite(dias)) return "Inativo";
  if (dias <= 30) return "Ativo";
  if (dias <= 60) return "Atenção";
  if (dias <= 90) return "Em risco";
  return "Inativo";
}

/** Data local 'YYYY-MM-DD' (comparação lexicográfica de vencimentos). */
function hojeISO(agora: Date): string {
  return `${agora.getFullYear()}-${pad2(agora.getMonth() + 1)}-${pad2(agora.getDate())}`;
}

/** 'YYYY-MM-DD' → 'MM/AAAA' (rótulo de período do histórico de vendedores). */
function mesAno(iso: string): string {
  return iso ? `${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—";
}

// ── ?busca=TERMO → lista de candidatos ────────────────────────────────────────
export function adaptClientesBusca(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
): ClienteResumo[] {
  const rows = asRows(raw?.resultados ?? raw);
  return rows
    .map((r) => ({
      codigo: clean(r.cod),
      nome: clean(r.nome) || clean(r.razao) || "—",
      razao: clean(r.razao),
      cnpj: clean(r.doc),
      cidade: "", // servidor não expõe município — apenas UF (Fase 2)
      uf: clean(r.uf),
    }))
    .filter((c) => c.codigo);
}

// ── ?cod=X → perfil 360º ──────────────────────────────────────────────────────
export function adaptClientePerfil(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
  agora: Date = new Date(),
): ClientePerfil {
  const d: Row = raw ?? {};
  if (d.erro) throw new Error(clean(d.erro));

  const cad: Row = d.cadastro ?? {};
  const k: Row = d.kpis ?? {}; // pode vir {} quando não há documento em 24m
  const tit: Row = d.titulos ?? {};

  // Dias sem compra: KPI (24m de documentos) ou fallback do cadastro (DtUltCmpCli).
  let dias: number | null = k.dias_sem_compra != null ? num(k.dias_sem_compra) : null;
  if (dias == null) {
    const ult = isoDate(cad.ultima_compra_cad);
    if (ult) {
      const t = new Date(`${ult}T00:00:00`).getTime();
      if (Number.isFinite(t)) dias = Math.max(0, Math.floor((agora.getTime() - t) / 86400000));
    }
  }

  const hoje = hojeISO(agora);
  const titulosLista = asRows(tit.lista);

  return {
    // Identificação (ClienteResumo)
    codigo: clean(cad.cod),
    nome: clean(cad.nome) || clean(cad.razao) || "—",
    razao: clean(cad.razao),
    cnpj: clean(cad.doc),
    cidade: "", // servidor não expõe município (Fase 2)
    uf: clean(cad.uf),

    // Cabeçalho — situação por recência + crédito
    situacao: situacaoPorDias(dias),
    diasUltimaCompra: dias ?? 0,
    limiteCredito: num(cad.limite_credito),
    limiteUtilizado: num(tit.valor), // exposição = títulos em aberto

    // KPIs 12 meses
    kpis: {
      totalComprado: num(k.comprado_12m),
      pedidos: num(k.pedidos_12m),
      ticket: num(k.ticket_medio),
      devolucoes: Math.abs(num(k.devolucoes_12m)),
      ultimaCompra: isoDate(k.ultima_compra ?? cad.ultima_compra_cad),
      frequenciaDias: num(k.freq_media_dias),
    },

    // Evolução de compras (mes = 'MM/AAAA', já ordenado pelo servidor)
    evolucao: asRows(d.evolucao).map((r) => ({ mes: clean(r.mes), valor: num(r.valor) })),

    // Top 10 produtos (12m, por valor)
    topProdutos: asRows(d.top_produtos).map((r) => ({
      descricao: clean(r.produto) || "—",
      quantidade: num(r.qtd),
      valor: num(r.valor),
    })),

    // Pizza de marcas (12m)
    marcas: asRows(d.top_marcas).map((r) => ({
      marca: clean(r.marca) || "—",
      valor: num(r.valor),
    })),

    // Histórico de vendedores — servidor ordena por último atendimento;
    // o primeiro é o ATUAL (badge). Período = 1º atendimento → último/atual.
    vendedores: asRows(d.vendedores).map((r) => ({
      vendedor: clean(r.vendedor) || "—",
      periodo: `${mesAno(isoDate(r.primeira))} — ${r.atual ? "atual" : mesAno(isoDate(r.ultima))}`,
      atual: Boolean(r.atual),
    })),

    // Últimas 15 compras — devolução em módulo (a tela prefixa "-")
    compras: asRows(d.ultimas_compras).map((r) => {
      const devolucao = Boolean(r.devolucao);
      const valor = num(r.valor);
      return {
        documento: clean(r.nr_doc),
        data: isoDate(r.data),
        valor: devolucao ? Math.abs(valor) : valor,
        devolucao,
      };
    }),

    // Orçamentos abertos (não convertidos, 180 dias)
    orcamentos: asRows(d.orcamentos_abertos).map((r) => ({
      numero: clean(r.nr),
      data: isoDate(r.data),
      dias: num(r.dias_aberto),
      valor: num(r.valor),
    })),

    // Títulos em aberto — vencido = vencimento anterior a hoje (data local)
    titulos: titulosLista.map((r) => {
      const vencimento = isoDate(r.vencimento);
      return {
        documento: clean(r.documento),
        vencimento,
        valor: num(r.valor),
        vencido: Boolean(vencimento && vencimento < hoje),
      };
    }),
  };
}
