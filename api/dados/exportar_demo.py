"""Exporta os payloads da API para o site estático.

    python -m dados.exportar_demo

Roda cada bot e cada consulta sob demanda uma vez contra o banco sintético e
grava o resultado em `web/public/demo/*.json`. É esse retrato que o front serve
quando publicado no GitHub Pages, onde não há backend.

Os arquivos saem com os MESMOS nomes que o front deriva das rotas da API
(`/dados/crm` → `dados-crm.json`), de modo que a única diferença entre o site
estático e o projeto completo é a origem do payload.
"""
from __future__ import annotations

import json
from pathlib import Path

import config
from bots.clientes import BotClientes
from bots.crm import BotCrm
from bots.dashboard import BotDashboard
from bots.estoque import BotEstoque
from bots.financeiro import BotFinanceiro
from bots.imposto import BotImposto
from bots.vendas import BotVendas
from consultas import cliente_marca_produto, painel_pedidos, perfil_cliente
from core.cache import limpar_para_json
from core.db import Database

DESTINO = config.RAIZ.parent / "web" / "public" / "demo"

#: quantos perfis de cliente entram no retrato (os que mais compraram)
PERFIS_NO_RETRATO = 40


def _gravar(nome: str, payload) -> None:
    caminho = DESTINO / f"{nome}.json"
    caminho.write_text(
        json.dumps(limpar_para_json(payload), ensure_ascii=False, default=str),
        encoding="utf-8",
    )
    print(f"  {caminho.name:38} {caminho.stat().st_size / 1024:8.1f} KB")


def exportar() -> None:
    DESTINO.mkdir(parents=True, exist_ok=True)
    db = Database(config.BANCO)
    print(f"exportando retrato para {DESTINO}")

    bots = [
        ("dashboard", BotDashboard), ("vendas", BotVendas), ("estoque", BotEstoque),
        ("financeiro", BotFinanceiro), ("crm", BotCrm), ("imposto", BotImposto),
        ("clientes", BotClientes),
    ]
    for nome, classe in bots:
        _gravar(f"dados-{nome}", classe(db).analisar())

    _gravar("dados-painel-pedidos", painel_pedidos(db))
    _gravar("dados-cliente-marca-produto", cliente_marca_produto(db, {}))

    # Cliente 360º: a lista alimenta a busca e os perfis o drill-down. Só os
    # maiores compradores entram — 520 perfis inteiros pesariam dezenas de MB.
    maiores = db.query(
        "SELECT d.cliente_codigo AS codigo FROM documento d"
        " JOIN item i ON i.documento_numero = d.numero"
        " WHERE d.tipo = 'venda' AND d.cancelado = 0"
        " GROUP BY d.cliente_codigo ORDER BY SUM(i.valor_total) DESC LIMIT ?",
        (PERFIS_NO_RETRATO,),
    )
    todos = db.query("SELECT codigo, nome, razao, cnpj, cidade, uf FROM cliente ORDER BY nome")
    perfis = {cod: perfil_cliente(db, cod) for cod in maiores["codigo"].tolist()}
    _gravar("dados-cliente", {
        "lista": todos.to_dict("records"),
        "perfis": perfis,
        "destaques": maiores["codigo"].tolist(),
    })

    # Estado dos bots: no retrato eles aparecem como "ok", com o horário da
    # exportação — o contador da barra lateral continua fazendo sentido.
    from datetime import datetime

    agora = datetime.now().strftime("%H:%M:%S")
    _gravar("status", {"bots": {
        nome: {"status": "ok", "ultimo_update": agora, "erro_msg": "",
               "segundos_para_o_proximo": config.INTERVALOS.get(nome, 300)}
        for nome, _ in bots
    }})

    _gravar("metas", {
        "meta_mensal_total": config.META_PADRAO,
        "metas_individuais": {
            linha["nome"]: float(linha["meta_mensal"])
            for linha in db.query("SELECT nome, meta_mensal FROM vendedor").to_dict("records")
        },
    })

    db.fechar()
    total = sum(f.stat().st_size for f in DESTINO.glob("*.json"))
    print(f"\nretrato completo: {total / 1024 / 1024:.1f} MB em {len(list(DESTINO.glob('*.json')))} arquivos")


if __name__ == "__main__":
    exportar()
