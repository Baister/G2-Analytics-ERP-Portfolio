// Período e filtros padrão REAIS — mês corrente calculado em runtime.
// Convenção: dentro de src/lib/api/** só imports RELATIVOS.

import type { CmpFiltros, Filtros, Periodo } from "./types";

function isoLocal(d: Date): string {
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mes}-${dia}`;
}

/** Primeiro dia do mês corrente até hoje (datas locais, ISO yyyy-mm-dd). */
export function periodoMesAtual(): Periodo {
  const hoje = new Date();
  return {
    inicio: isoLocal(new Date(hoje.getFullYear(), hoje.getMonth(), 1)),
    fim: isoLocal(hoje),
  };
}

export const PERIODO_MES_ATUAL: Periodo = periodoMesAtual();

export const FILTROS_PADRAO: Filtros = {
  vendedores: [],
  marcas: [],
  grupos: [],
  periodo: PERIODO_MES_ATUAL,
};

export const CMP_FILTROS_PADRAO: CmpFiltros = {
  periodo: PERIODO_MES_ATUAL,
  clientes: [],
  vendedores: [],
  marcas: [],
};
