"""Gera o banco de demonstração — um SQLite com 13 meses de operação fictícia.

    python -m dados.gerar            # cria api/dados/demo.db
    python -m dados.gerar --forcar   # recria do zero

Tudo aqui é inventado: nomes de vendedores, clientes, marcas e produtos não
existem. O que se procurou reproduzir foi o *comportamento* de uma
distribuidora — sazonalidade semanal, concentração de faturamento em poucos
clientes (Pareto), margem por família de produto, devoluções na casa de 2%,
inadimplência concentrada nos maiores títulos — para que os painéis mostrem
padrões que fazem sentido em vez de ruído uniforme.

Determinístico: mesma semente, mesmo banco. A janela é relativa a HOJE, então
a demonstração nunca parece congelada no tempo.
"""
from __future__ import annotations

import argparse
import random
import sqlite3
import unicodedata
from datetime import date, datetime, timedelta
from pathlib import Path

SEMENTE = 20260820
CAMINHO = Path(__file__).resolve().parent / "demo.db"

MESES_HISTORICO = 13
DOCS_POR_DIA_UTIL = 42          # média; varia por dia da semana e sazonalidade
PCT_DEVOLUCAO = 0.022           # documentos de devolução
PCT_CANCELADO = 0.011           # documentos cancelados

# ── Catálogos fictícios ───────────────────────────────────────────────────
NOMES = [
    "Alice", "Bruno", "Camila", "Diego", "Elisa", "Fábio", "Gabriela", "Heitor",
    "Isadora", "Joana", "Kléber", "Letícia", "Murilo", "Natália", "Otávio",
]
SOBRENOMES = [
    "Andrade", "Barreto", "Carvalho", "Dourado", "Esteves", "Fontoura",
    "Guimarães", "Hollanda", "Iglesias", "Junqueira", "Lacerda", "Machado",
    "Novaes", "Ourives", "Peixoto",
]
MARCAS = [
    "Aurelis", "Bravent", "Cindra", "Dorvan", "Eltrix", "Ferrion", "Grandel",
    "Havik", "Ivorra", "Junex", "Kaltra", "Lumnia", "Movent", "Norvik",
    "Opalis", "Prendal", "Quivex", "Rondal", "Solvarte", "Trevian",
]
GRUPOS = [
    "Fixação", "Elétrica", "Hidráulica", "Pintura", "Ferramentas",
    "Proteção", "Vedação", "Transmissão",
]
# Cada produto com as medidas que fazem sentido para ele. Sortear a medida de
# um saco único produzia coisas como "Lâmpada LED 900ml" — e um catálogo que
# não resiste a uma leitura atenta contamina a credibilidade do resto.
PRODUTOS_BASE: list[tuple[str, list[str]]] = [
    ("Parafuso sextavado", ["M6 x 30", "M8 x 40", "M10 x 50", '1/4" x 1"', '5/16" x 2"']),
    ("Arruela lisa", ["M6", "M8", "M10", '1/4"', '3/8"']),
    ("Bucha de nylon", ["6mm", "8mm", "10mm", "12mm"]),
    ("Rebite de alumínio", ["3,2 x 8", "4,0 x 10", "4,8 x 12"]),
    ("Abraçadeira inox", ["1/2\" a 1\"", '3/4" a 1.1/2"', '2" a 3"']),
    ("Cabo flexível", ["1,5mm²", "2,5mm²", "4,0mm²", "6,0mm²"]),
    ("Disjuntor bipolar", ["16A", "25A", "32A", "40A"]),
    ("Fita isolante", ["18mm x 10m", "19mm x 20m"]),
    ("Tomada de embutir", ["10A", "20A", "2P+T 10A"]),
    ("Conector prensado", ["2,5mm²", "6,0mm²", "16mm²"]),
    ("Lâmpada LED", ["9W", "12W", "15W", "20W"]),
    ("Registro esfera", ['1/2"', '3/4"', '1"']),
    ("Tubo soldável", ["20mm", "25mm", "32mm", "40mm"]),
    ("Joelho 90 graus", ["20mm", "25mm", "32mm"]),
    ("Adaptador com rosca", ['20mm x 1/2"', '25mm x 3/4"']),
    ("Tinta acrílica", ["3,6L", "18L", "900ml"]),
    ("Rolo de espuma", ['9"', '15cm', '23cm']),
    ("Pincel de cerdas", ['1"', '2"', '3"']),
    ("Chave combinada", ["8mm", "10mm", "13mm", "17mm"]),
    ("Alicate universal", ['6"', '8"']),
    ("Trena de aço", ["3m", "5m", "8m"]),
    ("Broca aço rápido", ["3mm", "6mm", "8mm", "10mm"]),
    ("Disco de corte", ['4.1/2"', '7"', '12"']),
    ("Luva nitrílica", ["P", "M", "G"]),
    ("Óculos de proteção", ["incolor", "fumê"]),
    ("Protetor auricular", ["plug", "concha"]),
    ("Anel de vedação", ["20mm", "25mm", "50mm"]),
    ("Silicone neutro", ["280g", "50g"]),
    ("Rolamento blindado", ["6203", "6204", "6205", "6305"]),
    ("Correia dentada", ["A-32", "A-40", "B-45"]),
    ("Graxa industrial", ["500g", "1kg"]),
]
RAZOES = [
    "Comercial", "Distribuidora", "Indústria", "Atacado", "Suprimentos",
    "Materiais", "Construções", "Instalações", "Manutenção", "Engenharia",
]
FANTASIA = [
    "Aurora", "Bandeirantes", "Central", "Dinâmica", "Estrela", "Frontal",
    "Guaraci", "Horizonte", "Ibirá", "Jacarandá", "Kairós", "Lumiar",
    "Marajó", "Nascente", "Oriente", "Pioneira", "Quatis", "Real",
    "Serrana", "Tucano", "União", "Vertente", "Xavante", "Zênite",
]
CIDADES = [
    ("Campinas", "SP"), ("Ribeirão Preto", "SP"), ("São Paulo", "SP"),
    ("Sorocaba", "SP"), ("Curitiba", "PR"), ("Londrina", "PR"),
    ("Belo Horizonte", "MG"), ("Uberlândia", "MG"), ("Goiânia", "GO"),
    ("Joinville", "SC"), ("Porto Alegre", "RS"), ("Vitória", "ES"),
]
ROTAS = ["Rota Centro", "Rota Litoral", "Rota Interior", "Rota Metropolitana"]

DDL = """
CREATE TABLE vendedor (
    id INTEGER PRIMARY KEY, nome TEXT NOT NULL, meta_mensal REAL NOT NULL
);
CREATE TABLE marca (id INTEGER PRIMARY KEY, nome TEXT NOT NULL);
CREATE TABLE grupo (id INTEGER PRIMARY KEY, nome TEXT NOT NULL);
CREATE TABLE produto (
    codigo TEXT PRIMARY KEY, descricao TEXT NOT NULL,
    marca_id INTEGER NOT NULL, grupo_id INTEGER NOT NULL,
    custo REAL NOT NULL, preco REAL NOT NULL,
    ncm TEXT NOT NULL, cst TEXT NOT NULL, aliquota_icms REAL NOT NULL,
    regra_pis_cofins TEXT NOT NULL
);
CREATE TABLE cliente (
    codigo TEXT PRIMARY KEY, nome TEXT NOT NULL, razao TEXT NOT NULL,
    cnpj TEXT NOT NULL, cidade TEXT NOT NULL, uf TEXT NOT NULL,
    vendedor_id INTEGER NOT NULL, limite_credito REAL NOT NULL,
    cadastro TEXT NOT NULL
);
CREATE TABLE documento (
    numero TEXT PRIMARY KEY, data TEXT NOT NULL, cliente_codigo TEXT NOT NULL,
    vendedor_id INTEGER NOT NULL, tipo TEXT NOT NULL, cancelado INTEGER NOT NULL,
    frete REAL NOT NULL, forma_pagamento TEXT NOT NULL,
    -- Camada fiscal: CFOP identifica a natureza da operação; dentro/fora do
    -- estado muda a alíquota, que é o que a aba de impostos analisa.
    cfop TEXT NOT NULL, dentro_estado INTEGER NOT NULL,
    base_icms REAL NOT NULL, valor_icms REAL NOT NULL,
    valor_st REAL NOT NULL, valor_ipi REAL NOT NULL
);
CREATE TABLE item (
    id INTEGER PRIMARY KEY AUTOINCREMENT, documento_numero TEXT NOT NULL,
    produto_codigo TEXT NOT NULL, quantidade REAL NOT NULL,
    valor_total REAL NOT NULL, custo_total REAL NOT NULL
);
CREATE TABLE titulo (
    numero TEXT PRIMARY KEY, documento_numero TEXT NOT NULL,
    cliente_codigo TEXT NOT NULL, emissao TEXT NOT NULL, vencimento TEXT NOT NULL,
    valor REAL NOT NULL, recebido_em TEXT, forma TEXT NOT NULL
);
CREATE TABLE orcamento (
    numero TEXT PRIMARY KEY, data TEXT NOT NULL, cliente_codigo TEXT NOT NULL,
    vendedor_id INTEGER NOT NULL, valor REAL NOT NULL, situacao TEXT NOT NULL,
    convertido_em TEXT
);
CREATE TABLE estoque (
    produto_codigo TEXT PRIMARY KEY, quantidade REAL NOT NULL,
    reservado REAL NOT NULL, ultima_venda TEXT
);
CREATE TABLE fila_pedido (
    pedido TEXT PRIMARY KEY, cliente_codigo TEXT NOT NULL, vendedor_id INTEGER NOT NULL,
    emissao TEXT NOT NULL, entrega TEXT NOT NULL, situacao TEXT NOT NULL,
    logistica TEXT NOT NULL, rota TEXT, valor REAL NOT NULL,
    registrado_em TEXT NOT NULL, nota TEXT, saida_hora TEXT
);
CREATE INDEX idx_doc_data ON documento(data);
CREATE INDEX idx_doc_cliente ON documento(cliente_codigo);
CREATE INDEX idx_doc_vendedor ON documento(vendedor_id);
CREATE INDEX idx_item_doc ON item(documento_numero);
CREATE INDEX idx_item_prod ON item(produto_codigo);
CREATE INDEX idx_titulo_venc ON titulo(vencimento);
CREATE INDEX idx_orc_data ON orcamento(data);
"""


def _sem_acento(t: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFD", t)
        if unicodedata.category(c) != "Mn"
    )


def _dia_util(d: date) -> bool:
    return d.weekday() < 5


def _peso_dia(d: date) -> float:
    """Segunda e terça vendem mais; sexta cai. Fim de mês aquece."""
    por_dia = {0: 1.18, 1: 1.12, 2: 1.0, 3: 0.96, 4: 0.82}
    base = por_dia.get(d.weekday(), 0.0)
    if d.day >= 25:
        base *= 1.15
    return base


def gerar(caminho: Path = CAMINHO, semente: int = SEMENTE) -> Path:
    rng = random.Random(semente)
    hoje = date.today()
    inicio = (hoje.replace(day=1) - timedelta(days=31 * (MESES_HISTORICO - 1))).replace(day=1)

    caminho.parent.mkdir(parents=True, exist_ok=True)
    if caminho.exists():
        caminho.unlink()
    con = sqlite3.connect(caminho)
    con.executescript(DDL)

    # ── dimensões ─────────────────────────────────────────────────────────
    vendedores = []
    for i in range(15):
        nome = f"{NOMES[i]} {SOBRENOMES[(i * 7) % len(SOBRENOMES)]}"
        # Calibrado contra o volume que este mesmo script gera: a soma das metas
        # tem de ficar perto do faturamento mensal, senão o painel de metas
        # mostra 500% e não significa nada.
        meta = round(rng.uniform(58_000, 128_000), -3)
        vendedores.append((i + 1, nome, meta))
    con.executemany("INSERT INTO vendedor VALUES (?,?,?)", vendedores)

    con.executemany("INSERT INTO marca VALUES (?,?)",
                    [(i + 1, m) for i, m in enumerate(MARCAS)])
    con.executemany("INSERT INTO grupo VALUES (?,?)",
                    [(i + 1, g) for i, g in enumerate(GRUPOS)])

    produtos = []
    for i in range(240):
        base, medidas = PRODUTOS_BASE[i % len(PRODUTOS_BASE)]
        medida = medidas[(i // len(PRODUTOS_BASE)) % len(medidas)]
        grupo_id = (i % len(GRUPOS)) + 1
        # Distribuidora de material técnico: a maior parte do catálogo é item
        # barato de giro alto, com uma cauda de itens caros.
        custo = round(rng.uniform(2.5, 60.0) if rng.random() < 0.8
                      else rng.uniform(60.0, 320.0), 2)
        margem = rng.uniform(0.22, 0.46)
        cst, aliq = rng.choices(
            [("000", 18.0), ("020", 12.0), ("040", 0.0), ("060", 0.0), ("102", 7.0)],
            [0.46, 0.18, 0.12, 0.16, 0.08],
        )[0]
        produtos.append((
            f"P{i + 1000}", f"{base} {medida}", (i % len(MARCAS)) + 1, grupo_id,
            custo, round(custo / (1 - margem), 2),
            f"{rng.randint(1000, 9999)}.{rng.randint(10, 99)}.{rng.randint(10, 99)}",
            cst, aliq, rng.choice(["Tributada", "Monofásica", "Alíquota zero", "Isenta"]),
        ))
    con.executemany("INSERT INTO produto VALUES (?,?,?,?,?,?,?,?,?,?)", produtos)

    clientes = []
    for i in range(520):
        fant = FANTASIA[i % len(FANTASIA)]
        razao_pref = RAZOES[(i // len(FANTASIA)) % len(RAZOES)]
        cidade, uf = CIDADES[i % len(CIDADES)]
        cnpj = f"{rng.randint(10, 99)}.{rng.randint(100, 999)}.{rng.randint(100, 999)}/0001-{rng.randint(10, 99)}"
        dias_cadastro = rng.randint(30, 2200)
        clientes.append((
            f"C{i + 1000}", f"{fant} {_sem_acento(razao_pref)}",
            f"{razao_pref} {fant} Ltda", cnpj, cidade, uf,
            (i % 15) + 1, round(rng.uniform(5_000, 120_000), -2),
            (hoje - timedelta(days=dias_cadastro)).isoformat(),
        ))
    con.executemany("INSERT INTO cliente VALUES (?,?,?,?,?,?,?,?,?)", clientes)

    # Curva de Pareto: 20% dos clientes concentram ~65% dos documentos.
    codigos = [c[0] for c in clientes]
    pesados = codigos[: int(len(codigos) * 0.2)]
    sorteio_cliente = pesados * 3 + codigos
    vendedor_do_cliente = {c[0]: c[6] for c in clientes}
    cliente_uf = {c[0]: c[5] for c in clientes}

    # 15% do catálogo não vende: é o estoque parado que a curva ABC precisa ter
    # para a classe C e o indicador de imobilizado significarem alguma coisa.
    vendaveis = produtos[: int(len(produtos) * 0.85)]

    # ── documentos, itens e títulos ───────────────────────────────────────
    docs, itens, titulos = [], [], []
    seq_doc = seq_tit = 0
    dia = inicio
    while dia <= hoje:
        if not _dia_util(dia):
            dia += timedelta(days=1)
            continue
        # Tendência de crescimento suave ao longo dos 13 meses.
        progresso = (dia - inicio).days / max(1, (hoje - inicio).days)
        fator = _peso_dia(dia) * (0.86 + 0.28 * progresso) * rng.uniform(0.85, 1.15)
        for _ in range(max(1, int(DOCS_POR_DIA_UTIL * fator))):
            seq_doc += 1
            numero = f"D{seq_doc:06d}"
            cliente = rng.choice(sorteio_cliente)
            # Em geral quem atende é o vendedor da carteira; de vez em quando
            # outro cobre o atendimento (e é isso que faz o filtro por vendedor
            # não ser idêntico ao filtro por cliente).
            vendedor = (vendedor_do_cliente[cliente] if rng.random() < 0.85
                        else rng.randint(1, 15))
            devolucao = rng.random() < PCT_DEVOLUCAO
            cancelado = 1 if (not devolucao and rng.random() < PCT_CANCELADO) else 0
            forma = rng.choices(["boleto", "cartao", "dinheiro"], [0.62, 0.29, 0.09])[0]
            frete = round(rng.uniform(0, 180), 2) if rng.random() < 0.35 else 0.0

            # CFOP 5xxx = dentro do estado, 6xxx = interestadual; x102 é venda
            # e x202 é devolução. A alíquota efetiva do painel cai quando as
            # operações interestaduais crescem — é esse contraste que a aba
            # de impostos mostra.
            dentro = 1 if cliente_uf[cliente] == "SP" else 0
            cfop = ("5202" if devolucao else "5102") if dentro else \
                   ("6202" if devolucao else "6102")

            total_doc = 0.0
            base_icms = valor_icms = valor_st = valor_ipi = 0.0
            for _ in range(rng.randint(1, 5)):
                prod = vendaveis[rng.randrange(len(vendaveis))]
                qtd = float(rng.randint(1, 12))
                sinal = -1.0 if devolucao else 1.0
                desconto = rng.uniform(0.0, 0.12)
                valor = round(prod[5] * qtd * (1 - desconto) * sinal, 2)
                custo = round(prod[4] * qtd * sinal, 2)
                itens.append((numero, prod[0], qtd * sinal, valor, custo))
                total_doc += valor

                # Item com substituição tributária (CST 060) não gera débito de
                # ICMS próprio; a alíquota interestadual é menor que a interna.
                cst, aliq_item = prod[7], prod[8]
                if cst == "060":
                    valor_st += round(abs(valor) * 0.11, 2) * sinal
                elif aliq_item > 0:
                    aliq_efetiva = aliq_item if dentro else min(aliq_item, 12.0)
                    base_icms += valor
                    valor_icms += round(valor * aliq_efetiva / 100, 2)
                if rng.random() < 0.18:
                    valor_ipi += round(valor * 0.05, 2)

            docs.append((
                numero, dia.isoformat(), cliente, vendedor,
                "devolucao" if devolucao else "venda", cancelado, frete, forma,
                cfop, dentro, round(base_icms, 2), round(valor_icms, 2),
                round(valor_st, 2), round(valor_ipi, 2),
            ))

            if not devolucao and not cancelado and forma in ("boleto", "cartao") and total_doc > 0:
                parcelas = rng.choice([1, 1, 1, 2, 3])
                for p in range(parcelas):
                    seq_tit += 1
                    venc = dia + timedelta(days=28 * (p + 1) + rng.randint(-3, 3))
                    valor_p = round(total_doc / parcelas, 2)
                    # Quem vence no futuro ainda não foi recebido. No passado, a
                    # chance de continuar em aberto CAI com a idade: cobrança
                    # recupera quase tudo com o tempo. Sem esse decaimento, os
                    # não pagos de treze meses se acumulam e a inadimplência do
                    # painel passa de 50% — número que não existe em operação viva.
                    if venc > hoje:
                        recebido = None
                    else:
                        idade = (hoje - venc).days
                        if idade <= 30:
                            chance_aberto = 0.15
                        elif idade <= 90:
                            chance_aberto = 0.04
                        else:
                            chance_aberto = 0.004
                        recebido = (None if rng.random() < chance_aberto
                                    else (venc + timedelta(days=rng.randint(-4, 8))).isoformat())
                    titulos.append((f"T{seq_tit:06d}", numero, cliente, dia.isoformat(),
                                    venc.isoformat(), valor_p, recebido, forma))
        dia += timedelta(days=1)

    con.executemany("INSERT INTO documento VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", docs)
    con.executemany(
        "INSERT INTO item (documento_numero, produto_codigo, quantidade, valor_total, custo_total)"
        " VALUES (?,?,?,?,?)", itens)
    con.executemany("INSERT INTO titulo VALUES (?,?,?,?,?,?,?,?)", titulos)

    # ── orçamentos (funil comercial dos últimos 120 dias) ─────────────────
    orcamentos = []
    seq_orc = 0
    dia = max(inicio, hoje - timedelta(days=120))
    while dia <= hoje:
        if _dia_util(dia):
            for _ in range(rng.randint(6, 18)):
                seq_orc += 1
                cliente = rng.choice(sorteio_cliente)
                valor = round(rng.uniform(400, 26_000), 2)
                r = rng.random()
                if r < 0.58:
                    situacao, convertido = "convertido", (dia + timedelta(days=rng.randint(0, 9))).isoformat()
                elif r < 0.78:
                    situacao, convertido = "aberto", None
                else:
                    situacao, convertido = "cancelado", None
                orcamentos.append((f"O{seq_orc:06d}", dia.isoformat(), cliente,
                                   int(cliente[1:]) % 15 + 1, valor, situacao, convertido))
        dia += timedelta(days=1)
    con.executemany("INSERT INTO orcamento VALUES (?,?,?,?,?,?,?)", orcamentos)

    # ── estoque (posição atual, com itens parados de propósito) ───────────
    # Mapa data-por-documento primeiro: procurar a data documento a documento
    # dentro do laço de itens seria O(n²) com dezenas de milhares de linhas.
    data_por_doc = {d[0]: d[1] for d in docs}
    ultima_venda: dict[str, str] = {}
    for numero, prod, qtd, *_ in itens:
        if qtd > 0:
            dt = data_por_doc[numero]
            if prod not in ultima_venda or dt > ultima_venda[prod]:
                ultima_venda[prod] = dt

    estoque = []
    for p in produtos:
        qtd = float(rng.randint(0, 900))
        if rng.random() < 0.06:
            qtd = 0.0
        estoque.append((p[0], qtd, round(qtd * rng.uniform(0, 0.15), 2),
                        ultima_venda.get(p[0])))
    con.executemany("INSERT INTO estoque VALUES (?,?,?,?)", estoque)

    # ── fila operacional de hoje (painel ao vivo) ─────────────────────────
    fila = []
    agora = datetime.now()
    for i in range(rng.randint(16, 26)):
        cliente = rng.choice(codigos)
        situacao = rng.choices(
            ["aguardando_faturamento", "aguardando_conferencia", "saiu"],
            [0.38, 0.33, 0.29])[0]
        retira = rng.random() < 0.45
        hora_reg = agora.replace(hour=rng.randint(8, 17), minute=rng.randint(0, 59),
                                 second=0, microsecond=0)
        entrega = hoje + timedelta(days=rng.choice([-1, 0, 0, 1, 2]))
        fila.append((
            f"PD{i + 100}", cliente, int(cliente[1:]) % 15 + 1,
            hoje.isoformat(), entrega.isoformat(), situacao,
            "retira" if retira else "rota", None if retira else rng.choice(ROTAS),
            round(rng.uniform(300, 18_000), 2), hora_reg.isoformat(timespec="minutes"),
            f"NF{rng.randint(10000, 99999)}" if situacao == "saiu" else None,
            hora_reg.strftime("%H:%M") if situacao == "saiu" else None,
        ))
    con.executemany("INSERT INTO fila_pedido VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", fila)

    con.commit()
    resumo = {
        "documentos": len(docs), "itens": len(itens), "titulos": len(titulos),
        "orcamentos": len(orcamentos), "clientes": len(clientes),
        "produtos": len(produtos), "fila": len(fila),
    }
    con.close()

    print(f"banco de demonstração: {caminho}")
    print(f"  janela: {inicio.isoformat()} → {hoje.isoformat()}")
    for k, v in resumo.items():
        print(f"  {k}: {v:,}".replace(",", "."))
    print(f"  tamanho: {caminho.stat().st_size / 1024 / 1024:.1f} MB")
    return caminho


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Gera o banco de demonstração.")
    ap.add_argument("--forcar", action="store_true", help="recria mesmo se já existir")
    ap.add_argument("--semente", type=int, default=SEMENTE)
    args = ap.parse_args()
    if CAMINHO.exists() and not args.forcar:
        print(f"{CAMINHO} já existe — use --forcar para recriar.")
    else:
        gerar(semente=args.semente)
