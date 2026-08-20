import { FileImage, FileSpreadsheet, FileText } from "lucide-react";
import { useRouterState } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { abaDaRota } from "@/lib/auth";
import { exportarExcel, exportarExcelDoDom, exportarImagem, exportarPdf } from "@/lib/export";
import type { SecaoExcel } from "@/lib/export";

/** Container capturado pelas exportações (definido no AppLayout). */
function conteudoDaPagina(): HTMLElement | null {
  return document.getElementById("conteudo-pagina");
}

export function PageHeader({
  title,
  subtitle,
  right,
  excel,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  /**
   * Getter das seções de dados da página — invocado só no clique do botão
   * Excel, sempre com os filtros correntes da tela. Sem a prop, o botão cai
   * no fallback genérico que varre as tabelas visíveis do DOM.
   */
  excel?: () => SecaoExcel[];
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Nome canônico da aba para o arquivo (g2-<aba>-<data>); título como reserva.
  const aba = abaDaRota(pathname) ?? title;

  return (
    <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {right}
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void (excel
              ? exportarExcel(excel(), aba)
              : exportarExcelDoDom(conteudoDaPagina(), aba))
          }
        >
          <FileSpreadsheet className="size-4" /> Excel
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void exportarPdf(conteudoDaPagina(), aba, title)}
        >
          <FileText className="size-4" /> PDF
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void exportarImagem(conteudoDaPagina(), aba)}
        >
          <FileImage className="size-4" /> Imagem
        </Button>
      </div>
    </header>
  );
}
