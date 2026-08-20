/**
 * Exportações Excel / PDF / Imagem — portado do projeto irmão Sysemp (validado em produção).
 *
 * - Excel: xlsx (SheetJS) — uma planilha por seção de dados ou por tabela visível no DOM.
 * - PDF: html2canvas-pro + jspdf — captura fatiada em páginas A4 (paisagem).
 * - Imagem: html2canvas-pro — PNG do conteúdo da página.
 *
 * html2canvas-pro é o fork compatível com cores oklch() do Tailwind v4
 * (o html2canvas clássico lança erro e o export falha silenciosamente).
 *
 * O fundo do app é lido em tempo de captura (getComputedStyle do body), para a
 * imagem/PDF sair igual à tela; #0d1117 fica apenas como reserva caso o estilo
 * não esteja disponível. Nome de arquivo: g2-<aba>-<AAAA-MM-DD>.
 *
 * As bibliotecas pesadas são importadas dinamicamente para não inchar o bundle
 * inicial — só carregam no primeiro clique de exportação.
 */

import { toast } from "sonner";

import { dt } from "./format";

const FUNDO_RESERVA = "#0d1117";

/** Fundo real do app no momento da captura (resolve oklch/rgb do tema atual). */
function corDeFundo(): string {
  if (typeof document === "undefined") return FUNDO_RESERVA;
  const cor = getComputedStyle(document.body).backgroundColor;
  if (!cor || cor === "transparent" || cor === "rgba(0, 0, 0, 0)") return FUNDO_RESERVA;
  return cor;
}

function dataHoje(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function slug(texto: string): string {
  return (
    texto
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "pagina"
  );
}

/** Nome padrão dos arquivos exportados: g2-<aba>-<AAAA-MM-DD> (sem extensão). */
export function nomeArquivo(aba: string): string {
  return `g2-${slug(aba)}-${dataHoje()}`;
}

/** Nome de planilha válido no Excel: máx. 31 chars, sem \ / ? * [ ] :, sem repetição. */
function nomePlanilha(nome: string, usados: Set<string>): string {
  const base =
    nome
      .replace(/[\\/?*[\]:]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 31)
      .trim() || "Dados";
  let final = base;
  let n = 2;
  while (usados.has(final.toLowerCase())) {
    const sufixo = ` ${n++}`;
    final = base.slice(0, 31 - sufixo.length).trimEnd() + sufixo;
  }
  usados.add(final.toLowerCase());
  return final;
}

export interface SecaoExcel {
  nome: string;
  linhas: Record<string, unknown>[];
}

/** "A, B, C" — ou o rótulo neutro ("Todos"/"Todas") quando nada está selecionado. */
export function listaOuTodos(valores: string[], todos = "Todos"): string {
  return valores.length ? valores.join(", ") : todos;
}

/** Período legível para a seção Filtros: "01/08/2026 a 05/08/2026". */
export function periodoTexto(periodo: { inicio: string; fim: string }): string {
  return `${dt(periodo.inicio)} a ${dt(periodo.fim)}`;
}

/**
 * Seção padrão "Filtros" (colunas Campo/Valor) com carimbo "Exportado em"
 * na última linha. `nome` permite reaproveitar o formato campo/valor em
 * outras seções (ex.: "Cadastro" do Cliente 360º).
 */
export function secaoFiltros(campos: [string, unknown][], nome = "Filtros"): SecaoExcel {
  return {
    nome,
    linhas: [
      ...campos.map(([campo, valor]) => ({ Campo: campo, Valor: valor })),
      { Campo: "Exportado em", Valor: new Date().toLocaleString("pt-BR") },
    ],
  };
}

/** Seção de indicadores (colunas Indicador/Valor) — números CRUS, sem brl()/pct(). */
export function secaoIndicadores(nome: string, indicadores: [string, unknown][]): SecaoExcel {
  return {
    nome,
    linhas: indicadores.map(([indicador, valor]) => ({ Indicador: indicador, Valor: valor })),
  };
}

/** Exporta seções de dados tipados — cada seção vira uma aba da planilha. */
export async function exportarExcel(secoes: SecaoExcel[], aba: string): Promise<void> {
  const comDados = secoes.filter((s) => s.linhas.length > 0);
  if (!comDados.length) {
    toast.error("Nada para exportar com os dados atuais.");
    return;
  }
  try {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    const usados = new Set<string>();
    for (const secao of comDados) {
      const ws = XLSX.utils.json_to_sheet(secao.linhas);
      XLSX.utils.book_append_sheet(wb, ws, nomePlanilha(secao.nome, usados));
    }
    XLSX.writeFile(wb, `${nomeArquivo(aba)}.xlsx`);
    toast.success("Excel exportado com sucesso.");
  } catch {
    toast.error("Não foi possível gerar o Excel.");
  }
}

/** Título de uma tabela do DOM: caption → aria-label → título do Panel → fallback. */
function tituloDaTabela(tabela: HTMLTableElement, indice: number): string {
  const caption = tabela.caption?.textContent?.trim();
  if (caption) return caption;
  const aria = tabela.getAttribute("aria-label")?.trim();
  if (aria) return aria;
  const titulo = tabela.closest("section")?.querySelector("header h2")?.textContent?.trim();
  if (titulo) return titulo;
  return `Tabela ${indice + 1}`;
}

/**
 * Exportação genérica: varre as tabelas visíveis dentro do elemento raiz da
 * página e gera uma aba de planilha por tabela (como o Sysemp faz).
 */
export async function exportarExcelDoDom(raiz: HTMLElement | null, aba: string): Promise<void> {
  if (!raiz) {
    toast.error("Conteúdo da página não encontrado para exportar.");
    return;
  }
  const tabelas = Array.from(raiz.querySelectorAll("table")).filter(
    (t) => t.offsetParent !== null,
  );
  if (!tabelas.length) {
    toast.error("Nenhuma tabela visível para exportar nesta página.");
    return;
  }
  try {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    const usados = new Set<string>();
    tabelas.forEach((tabela, i) => {
      const ws = XLSX.utils.table_to_sheet(tabela);
      XLSX.utils.book_append_sheet(wb, ws, nomePlanilha(tituloDaTabela(tabela, i), usados));
    });
    XLSX.writeFile(wb, `${nomeArquivo(aba)}.xlsx`);
    toast.success(
      tabelas.length === 1
        ? "Excel exportado com 1 tabela."
        : `Excel exportado com ${tabelas.length} tabelas.`,
    );
  } catch {
    toast.error("Não foi possível gerar o Excel.");
  }
}

async function capturar(elemento: HTMLElement): Promise<HTMLCanvasElement> {
  const html2canvas = (await import("html2canvas-pro")).default;
  return html2canvas(elemento, {
    backgroundColor: corDeFundo(),
    scale: 2,
    logging: false,
    useCORS: true,
  });
}

/** Exporta o elemento (conteúdo da página) como PNG. */
export async function exportarImagem(elemento: HTMLElement | null, aba: string): Promise<void> {
  if (!elemento) {
    toast.error("Conteúdo da página não encontrado para captura.");
    return;
  }
  const id = toast.loading("Gerando imagem...");
  try {
    const canvas = await capturar(elemento);
    const link = document.createElement("a");
    link.download = `${nomeArquivo(aba)}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
    toast.success("Imagem exportada com sucesso.", { id });
  } catch {
    toast.error("Não foi possível gerar a imagem.", { id });
  }
}

/** Exporta o elemento como PDF A4 (paisagem), fatiando em múltiplas páginas. */
export async function exportarPdf(
  elemento: HTMLElement | null,
  aba: string,
  titulo: string,
): Promise<void> {
  if (!elemento) {
    toast.error("Conteúdo da página não encontrado para captura.");
    return;
  }
  const id = toast.loading("Gerando PDF...");
  try {
    const fundo = corDeFundo();
    const canvas = await capturar(elemento);
    const { jsPDF } = await import("jspdf");
    const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 32;
    const imgW = pageW - margin * 2;
    const pxPorPt = canvas.width / imgW;

    // Fatia o conteúdo em páginas A4 — sem esmagar a dashboard numa folha só.
    let offsetPx = 0;
    let pagina = 0;
    while (offsetPx < canvas.height) {
      if (pagina > 0) pdf.addPage();
      const topoPt = pagina === 0 ? 46 : 24;
      if (pagina === 0) {
        pdf.setFontSize(14);
        pdf.text(titulo, margin, 34);
      }
      const alturaPt = pageH - topoPt - margin;
      const fatiaPx = Math.min(canvas.height - offsetPx, Math.floor(alturaPt * pxPorPt));
      const fatia = document.createElement("canvas");
      fatia.width = canvas.width;
      fatia.height = fatiaPx;
      const ctx = fatia.getContext("2d");
      if (!ctx) throw new Error("canvas 2d indisponível");
      ctx.fillStyle = fundo;
      ctx.fillRect(0, 0, fatia.width, fatia.height);
      ctx.drawImage(canvas, 0, offsetPx, canvas.width, fatiaPx, 0, 0, canvas.width, fatiaPx);
      pdf.addImage(
        fatia.toDataURL("image/png"),
        "PNG",
        margin,
        topoPt,
        imgW,
        fatiaPx / pxPorPt,
        undefined,
        "FAST",
      );
      offsetPx += fatiaPx;
      pagina++;
    }
    pdf.save(`${nomeArquivo(aba)}.pdf`);
    toast.success("PDF exportado com sucesso.", { id });
  } catch {
    toast.error("Não foi possível gerar o PDF.", { id });
  }
}
