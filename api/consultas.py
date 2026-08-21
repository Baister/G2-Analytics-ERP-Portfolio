"""Consultas sob demanda — calculadas no pedido, não em ciclo de bot.

Nem tudo vale um bot. Estas quatro análises dependem de um parâmetro que só
existe no momento do clique (um código de cliente, uma combinação de filtros),
então rodam na hora e são protegidas por micro-cache no `server.py`.

O padrão é o mesmo em todas: um dicionário de consultas independentes, execução
em paralelo com falha isolada, e montagem do payload em Python.
"""
from __future__ import annotations

import concurrent.futures as cf
from datetime import date, datetime, timedelta  # noqa: F401 - timedelta usado no deslocamento

import pandas as pd

from bots.base import registros


def _paralelo(db, consultas: dict[str, tuple[str, tuple]]) -> dict[str, pd.DataFrame]:
    saida: dict[str, pd.DataFrame] = {}
    with cf.ThreadPoolExecutor(max_workers=4) as pool:
        futuros = {pool.submit(db.query, sql, p): k for k, (sql, p) in consultas.items()}
        for fut in cf.as_completed(futuros):
            chave = futuros[fut]
            try:
                saida[chave] = fut.result()
            except Exception:
                saida[chave] = pd.DataFrame()
    return saida


def _f(df: pd.DataFrame, coluna: str, padrao: float = 0.0) -> float:
    if df is None or df.empty or coluna not in df.columns:
        return padrao
    valor = df[coluna].iloc[0]
    return padrao if valor is None or pd.isna(valor) else float(valor)


def _situacao(dias: int | None) -> str:
    if dias is None:
        return "Inativo"
    if dias <= 30:
        return "Ativo"
    if dias <= 60:
        return "Atenção"
    if dias <= 90:
        return "Em risco"
    return "Inativo"


# ── Busca de clientes ─────────────────────────────────────────────────────
def busca_clientes(db, termo: str) -> dict:
    """Busca por nome, razão social, código ou CNPJ. Máximo de 20 resultados."""
    like = f"%{termo.lower()[:60]}%"
    df = db.query(
        """
        SELECT c.codigo, c.nome, c.razao, c.cnpj, c.cidade, c.uf,
               MAX(d.data) AS ultima_compra
        FROM cliente c
        LEFT JOIN documento d ON d.cliente_codigo = c.codigo AND d.tipo = 'venda'
        WHERE lower(c.nome) LIKE ? OR lower(c.razao) LIKE ?
           OR lower(c.codigo) LIKE ? OR c.cnpj LIKE ?
        GROUP BY c.codigo, c.nome, c.razao, c.cnpj, c.cidade, c.uf
        ORDER BY ultima_compra DESC
        LIMIT 20
        """,
        (like, like, like, like),
    )
    return {"modo": "busca", "clientes": registros(df)}


# ── Perfil 360º ───────────────────────────────────────────────────────────
def perfil_cliente(db, codigo: str) -> dict:
    hoje = date.today()
    doze_meses = (hoje - timedelta(days=365)).isoformat()

    dfs = _paralelo(db, {
        "cadastro": (
            "SELECT c.codigo, c.nome, c.razao, c.cnpj, c.cidade, c.uf,"
            "       c.limite_credito, v.nome AS vendedor"
            " FROM cliente c JOIN vendedor v ON v.id = c.vendedor_id"
            " WHERE c.codigo = ?", (codigo,)),
        "kpis": (
            "SELECT ROUND(SUM(CASE WHEN d.tipo='venda' THEN i.valor_total ELSE 0 END),2) AS comprado,"
            "       COUNT(DISTINCT CASE WHEN d.tipo='venda' THEN d.numero END) AS pedidos,"
            "       ROUND(SUM(CASE WHEN d.tipo='devolucao' THEN -i.valor_total ELSE 0 END),2) AS devolucoes,"
            "       MAX(d.data) AS ultima_compra, MIN(d.data) AS primeira_compra"
            " FROM documento d JOIN item i ON i.documento_numero = d.numero"
            " WHERE d.cliente_codigo = ? AND d.cancelado = 0 AND d.data >= ?",
            (codigo, doze_meses)),
        "evolucao": (
            "SELECT substr(d.data,1,7) AS mes, ROUND(SUM(i.valor_total),2) AS valor"
            " FROM documento d JOIN item i ON i.documento_numero = d.numero"
            " WHERE d.cliente_codigo = ? AND d.cancelado = 0 AND d.data >= ?"
            " GROUP BY mes ORDER BY mes", (codigo, doze_meses)),
        "produtos": (
            "SELECT p.descricao, ROUND(SUM(i.quantidade),2) AS quantidade,"
            "       ROUND(SUM(i.valor_total),2) AS valor"
            " FROM documento d JOIN item i ON i.documento_numero = d.numero"
            " JOIN produto p ON p.codigo = i.produto_codigo"
            " WHERE d.cliente_codigo = ? AND d.cancelado = 0 AND d.data >= ?"
            " GROUP BY p.descricao ORDER BY valor DESC LIMIT 10", (codigo, doze_meses)),
        "marcas": (
            "SELECT m.nome AS marca, ROUND(SUM(i.valor_total),2) AS valor"
            " FROM documento d JOIN item i ON i.documento_numero = d.numero"
            " JOIN produto p ON p.codigo = i.produto_codigo"
            " JOIN marca m ON m.id = p.marca_id"
            " WHERE d.cliente_codigo = ? AND d.cancelado = 0 AND d.data >= ?"
            " GROUP BY m.nome ORDER BY valor DESC LIMIT 6", (codigo, doze_meses)),
        "compras": (
            "SELECT d.numero AS documento, d.data, d.tipo,"
            "       ROUND(SUM(i.valor_total),2) AS valor"
            " FROM documento d JOIN item i ON i.documento_numero = d.numero"
            " WHERE d.cliente_codigo = ? AND d.cancelado = 0"
            " GROUP BY d.numero, d.data, d.tipo ORDER BY d.data DESC LIMIT 15", (codigo,)),
        "orcamentos": (
            "SELECT numero, data, ROUND(valor,2) AS valor"
            " FROM orcamento WHERE cliente_codigo = ? AND situacao = 'aberto'"
            " ORDER BY data DESC LIMIT 10", (codigo,)),
        "titulos": (
            "SELECT numero AS documento, vencimento, ROUND(valor,2) AS valor"
            " FROM titulo WHERE cliente_codigo = ? AND recebido_em IS NULL"
            " ORDER BY vencimento LIMIT 20", (codigo,)),
        "aberto": (
            "SELECT ROUND(SUM(valor),2) AS utilizado FROM titulo"
            " WHERE cliente_codigo = ? AND recebido_em IS NULL", (codigo,)),
    })

    cad = dfs.get("cadastro")
    if cad is None or cad.empty:
        return {"erro": f"cliente '{codigo}' não encontrado"}
    c = registros(cad)[0]

    kp = dfs.get("kpis")
    comprado = _f(kp, "comprado")
    pedidos = int(_f(kp, "pedidos"))
    ultima = None
    if kp is not None and not kp.empty and kp["ultima_compra"].iloc[0]:
        ultima = str(kp["ultima_compra"].iloc[0])
    dias_ultima = (hoje - date.fromisoformat(ultima)).days if ultima else None

    # Frequência média entre compras: só faz sentido com 2+ pedidos.
    frequencia = 0
    if pedidos > 1 and kp is not None and not kp.empty and kp["primeira_compra"].iloc[0]:
        janela = (date.fromisoformat(ultima)
                  - date.fromisoformat(str(kp["primeira_compra"].iloc[0]))).days
        frequencia = int(janela / max(1, pedidos - 1))

    return {
        "cliente": {**c, "situacao": _situacao(dias_ultima),
                    "dias_ultima_compra": dias_ultima if dias_ultima is not None else 9999,
                    "limite_utilizado": _f(dfs.get("aberto"), "utilizado")},
        "kpis": {
            "total_comprado": comprado, "pedidos": pedidos,
            "ticket": round(comprado / pedidos, 2) if pedidos else 0.0,
            "devolucoes": _f(kp, "devolucoes"),
            "ultima_compra": ultima or "", "frequencia_dias": frequencia,
        },
        "evolucao": registros(dfs.get("evolucao")),
        "top_produtos": registros(dfs.get("produtos")),
        "marcas": registros(dfs.get("marcas")),
        "compras": registros(dfs.get("compras")),
        "orcamentos": registros(dfs.get("orcamentos")),
        "titulos": registros(dfs.get("titulos")),
        "hoje": hoje.isoformat(),
    }


# ── Painel operacional ────────────────────────────────────────────────────
def painel_pedidos(db) -> dict:
    df = db.query(
        """
        SELECT f.pedido, c.razao AS razao_social, v.nome AS vendedor,
               f.emissao, f.entrega, f.situacao, f.logistica, f.rota,
               ROUND(f.valor,2) AS valor, f.registrado_em, f.nota, f.saida_hora
        FROM fila_pedido f
        JOIN cliente c ON c.codigo = f.cliente_codigo
        JOIN vendedor v ON v.id = f.vendedor_id
        ORDER BY f.registrado_em
        """
    )
    hoje = date.today()
    agora = datetime.now()
    filas: dict[str, list[dict]] = {
        "aguardando_faturamento": [], "aguardando_conferencia": [], "saiu_hoje": []}

    linhas = registros(df)

    # A fila de expedição é um painel AO VIVO — a tela do balcão só mostra o
    # que foi registrado HOJE. O dataset, porém, foi gerado num dia específico:
    # no dia seguinte o telão apareceria vazio. As datas são então deslocadas
    # em bloco para o dia atual, preservando o horário e a distância relativa
    # entre emissão, registro e entrega (um pedido com entrega vencida continua
    # vencido). É o único ponto do projeto que reposiciona o dado no tempo, e
    # existe para a demonstração não depender de quando o banco foi gerado.
    deslocamento = timedelta(0)
    if linhas:
        base = max(
            (str(l.get("registrado_em") or "")[:10] for l in linhas if l.get("registrado_em")),
            default="",
        )
        if base:
            deslocamento = hoje - date.fromisoformat(base)

    def desloca_data(valor: str | None) -> str:
        if not valor:
            return ""
        try:
            return (date.fromisoformat(valor[:10]) + deslocamento).isoformat()
        except ValueError:
            return valor

    for linha in linhas:
        registrado_orig = linha.get("registrado_em") or ""
        registrado = (f"{desloca_data(registrado_orig)}T{registrado_orig[11:16]}"
                      if registrado_orig else "")
        linha["emissao"] = desloca_data(linha.get("emissao"))
        linha["entrega"] = desloca_data(linha.get("entrega"))
        try:
            horas_fila = round((agora - datetime.fromisoformat(registrado)).total_seconds() / 3600, 1)
        except ValueError:
            horas_fila = 0.0
        pedido = {
            "pedido": linha["pedido"], "razao_social": linha["razao_social"],
            "vendedor": linha["vendedor"], "emissao": linha["emissao"],
            "entrega": linha["entrega"],
            "entrega_vencida": bool(linha["entrega"] and linha["entrega"] < hoje.isoformat()),
            "logistica": {"tipo": linha["logistica"],
                          "nome": linha["rota"] or "Retira na loja"},
            "valor": linha["valor"], "horas_fila": max(0.0, horas_fila),
            "nf": linha.get("nota"), "hora": linha.get("saida_hora"),
            "registro_iso": registrado[:10], "registro_hora": registrado[11:16],
        }
        destino = {"aguardando_faturamento": "aguardando_faturamento",
                   "aguardando_conferencia": "aguardando_conferencia",
                   "saiu": "saiu_hoje"}[linha["situacao"]]
        filas[destino].append(pedido)

    resumo = [
        {"status": rotulo, "pedidos": len(filas[chave]),
         "valor": round(sum(p["valor"] for p in filas[chave]), 2)}
        for chave, rotulo in [("aguardando_faturamento", "Aguardando Faturamento"),
                              ("aguardando_conferencia", "Aguardando Conferência"),
                              ("saiu_hoje", "Saiu Hoje")]
    ]
    return {"resumo": resumo, **filas, "hoje": hoje.isoformat()}


# ── Cliente × Marca × Produto ─────────────────────────────────────────────
def cliente_marca_produto(db, filtros: dict) -> dict:
    """Análise cruzada com filtros combináveis.

    Os quatro filtros recortam TODOS os painéis, e os indicadores saem do
    conjunto completo filtrado — não da soma do top N, que daria um total
    menor que o real e confundiria quem confere.
    """
    hoje = date.today()
    ini = filtros.get("dt_de") or hoje.replace(day=1).isoformat()
    ate = filtros.get("dt_ate") or hoje.isoformat()
    if ini > ate:
        ini, ate = ate, ini
    # Janela máxima de um ano: sem isso, um período aberto varre a base inteira.
    if (date.fromisoformat(ate) - date.fromisoformat(ini)).days > 366:
        ini = (date.fromisoformat(ate) - timedelta(days=366)).isoformat()

    where = ["d.data >= ?", "d.data <= ?", "d.cancelado = 0"]
    params: list = [ini, ate]

    def entra(coluna: str, valores: list[str]) -> None:
        if valores:
            where.append(f"{coluna} IN ({','.join('?' for _ in valores)})")
            params.extend(valores)

    entra("d.cliente_codigo", filtros.get("clientes") or [])
    entra("v.nome", filtros.get("vendedores") or [])
    entra("m.nome", filtros.get("marcas") or [])
    filtro = " AND ".join(where)

    juncao = (
        " FROM documento d"
        " JOIN item i ON i.documento_numero = d.numero"
        " JOIN produto p ON p.codigo = i.produto_codigo"
        " JOIN marca m ON m.id = p.marca_id"
        " JOIN cliente c ON c.codigo = d.cliente_codigo"
        " JOIN vendedor v ON v.id = d.vendedor_id"
        f" WHERE {filtro}"
    )
    agregacao = (
        " ROUND(SUM(CASE WHEN d.tipo='venda' THEN i.valor_total ELSE 0 END),2) AS venda_liquida,"
        " ROUND(SUM(CASE WHEN d.tipo='venda' THEN i.custo_total ELSE 0 END),2) AS custo,"
        " ROUND(SUM(CASE WHEN d.tipo='devolucao' THEN -i.valor_total ELSE 0 END),2) AS devolucao,"
        " ROUND(SUM(i.quantidade),2) AS quantidade,"
        " COUNT(DISTINCT CASE WHEN d.tipo='venda' THEN d.numero END) AS documentos"
    )

    dfs = _paralelo(db, {
        "kpis": (f"SELECT {agregacao} {juncao}", tuple(params)),
        "por_cliente": (
            f"SELECT d.cliente_codigo AS codigo, c.nome AS cliente, {agregacao}"
            f" {juncao} GROUP BY d.cliente_codigo, c.nome"
            " ORDER BY venda_liquida DESC LIMIT 100", tuple(params)),
        "por_marca": (
            f"SELECT m.nome AS marca, {agregacao}"
            f" {juncao} GROUP BY m.nome ORDER BY venda_liquida DESC LIMIT 50", tuple(params)),
        "por_item": (
            f"SELECT p.codigo, p.descricao AS item, m.nome AS marca, {agregacao}"
            f" {juncao} GROUP BY p.codigo, p.descricao, m.nome"
            " ORDER BY venda_liquida DESC LIMIT 100", tuple(params)),
        "frete": (
            "SELECT ROUND(SUM(frete),2) AS frete FROM documento"
            " WHERE data >= ? AND data <= ? AND cancelado = 0", (ini, ate)),
        "cat_clientes": (
            "SELECT codigo, nome FROM cliente ORDER BY nome LIMIT 500", ()),
        "cat_vendedores": ("SELECT CAST(id AS TEXT) AS codigo, nome FROM vendedor ORDER BY nome", ()),
        "cat_marcas": ("SELECT nome FROM marca ORDER BY nome", ()),
    })

    def enriquecer(linhas: list[dict]) -> list[dict]:
        for l in linhas:
            venda, custo = l.get("venda_liquida") or 0.0, l.get("custo") or 0.0
            docs = l.get("documentos") or 0
            l["lucro"] = round(venda - custo, 2)
            l["margem"] = round((venda - custo) / venda * 100, 2) if venda else 0.0
            l["ticket_medio"] = round(venda / docs, 2) if docs else 0.0
        return linhas

    kp = enriquecer(registros(dfs.get("kpis")) or [{}])[0]
    return {
        "kpis": {
            "venda_liquida": kp.get("venda_liquida") or 0.0,
            "custo": kp.get("custo") or 0.0,
            "devolucao": kp.get("devolucao") or 0.0,
            "quantidade": kp.get("quantidade") or 0.0,
            "documentos": kp.get("documentos") or 0,
            "lucro": kp.get("lucro") or 0.0,
            "margem": kp.get("margem") or 0.0,
            "ticket_medio": kp.get("ticket_medio") or 0.0,
            # O frete é do documento, não do item: o filtro de marca não o recorta.
            "frete": _f(dfs.get("frete"), "frete"),
        },
        "por_cliente": enriquecer(registros(dfs.get("por_cliente"))),
        "por_marca": enriquecer(registros(dfs.get("por_marca"))),
        "por_item": enriquecer(registros(dfs.get("por_item"))),
        "clientes": registros(dfs.get("cat_clientes")),
        "vendedores": registros(dfs.get("cat_vendedores")),
        "marcas": [l["nome"] for l in registros(dfs.get("cat_marcas"))],
        "janela": {"de": ini, "ate": ate},
    }
