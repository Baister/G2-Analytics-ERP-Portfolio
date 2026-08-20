# G2 Analytics — front

Interface do hub de BI. **TanStack Start** (React 19 com renderização no servidor), Tailwind v4, Recharts e componentes shadcn/ui.

Consome a API FastAPI do projeto — a visão geral do sistema está no [README da raiz](../../README.md).

---

## Rodando

```bash
npm install
npm run build          # obrigatório antes do start
PORT=8790 npm start    # → http://localhost:8790
```

No PowerShell: `$env:PORT=8790; npm start`.

| Script | O que faz |
|---|---|
| `npm run dev` | Vite em modo desenvolvimento, com HMR |
| `npm run build` | Build de produção (gera `.output/`) |
| `npm start` | Serve o build (`node .output/server/index.mjs`) — porta via `PORT`, padrão 3000 |
| `npm run lint` | ESLint |
| `npx tsc --noEmit` | Checagem de tipos |

> **Regra que economiza tempo:** `npm start` serve o **build**, não o código-fonte. Alterou algo em `src/`? Rode `npm run build` antes de testar, senão você vai olhar para a versão anterior.

**API:** por padrão o front chama a porta 8765 do mesmo host que o serve. Para apontar para outro lugar, defina `VITE_API_URL` no build. O login guarda token e abas permitidas em `localStorage` (`g2:token`, `g2:tabs`); um 401 limpa a sessão e volta para a tela de entrada.

---

## Organização

```
src/
├── routes/              ← uma tela por arquivo (roteamento por arquivo do TanStack)
│                          routeTree.gen.ts é GERADO — não edite
├── lib/
│   ├── api/
│   │   ├── client.ts    ← fetch autenticado, base da API, tratamento de 401
│   │   ├── hooks.ts     ← um hook por aba (useDashboard, useCmp, …)
│   │   ├── adapters/    ← funções puras: payload cru da API → contrato da tela
│   │   ├── types.ts     ← contratos de dados (um por aba)
│   │   └── periodo.ts   ← período e filtros padrão
│   ├── auth.ts          ← sessão, perfis e mapa rota → aba
│   ├── export.ts        ← geração de Excel/PDF/imagem
│   ├── theme.ts         ← tema claro/escuro (localStorage g2-theme)
│   └── format.ts        ← brl, num, pct, dt (pt-BR)
└── components/
    ├── g2/              ← componentes do produto: KpiCard, Panel, DataTable,
    │                      Filters, charts, PageHeader, AppSidebar, ExpandView
    └── ui/              ← primitivos shadcn/ui (não editar à mão)
```

### Fluxo de dados

**Tela → hook → adaptador → API.** As telas nunca chamam `fetch` nem conhecem o formato do backend: pedem dados ao hook da aba, que busca o payload cru e o entrega convertido por um adaptador puro no formato tipado de `types.ts`.

Isso mantém as regras de negócio testáveis fora do navegador e permite trocar a origem do dado sem tocar em nenhuma tela — foi o que permitiu migrar de dados de demonstração para a API real sem reescrever páginas.

Dentro de `src/lib/api/**` use **apenas imports relativos**: esses módulos rodam fora do bundler no smoke test.

### Convenções

- **Dinheiro** sempre em BRL com 2 casas nos KPIs, tabelas e tooltips; eixos podem abreviar. Datas `dd/mm/aaaa`, percentuais com 1 casa.
- **Toda aba** tem cabeçalho com exportação (Excel/PDF/imagem) e o `excel` recebe um getter que monta as seções na hora do clique.
- **Tabelas** (`DataTable`) trazem busca, ordenação por coluna, paginação e modo expandido; tabelas dentro de modais recebem `nested` para não abrir modal sobre modal.
- **Tema** claro/escuro definido por tokens em `styles.css` — cores novas entram como token, nunca como valor fixo no componente.

---

## Testes

```bash
npx tsc --noEmit
npm run build
npx tsx scripts/smoke_adapters.ts <pasta-com-payloads>
```

O smoke roda todos os adaptadores contra payloads reais capturados da API e falha em `NaN`, contrato ausente ou texto sem `trim`. Os payloads **nunca entram no repositório** — ficam fora dele e o caminho é passado por argumento.
