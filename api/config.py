"""Configuração da API de demonstração.

Num sistema real isto viria de variáveis de ambiente ou de um arquivo fora do
versionamento. Aqui os valores são públicos de propósito: o banco é sintético e
as senhas existem para demonstrar o controle de acesso por perfil, não para
proteger nada.
"""
from __future__ import annotations

import os
from pathlib import Path

RAIZ = Path(__file__).resolve().parent

BANCO = Path(os.getenv("G2_BANCO", RAIZ / "dados" / "demo.db"))
CACHE = Path(os.getenv("G2_CACHE", RAIZ / "cache_demo.db"))
PORTA = int(os.getenv("G2_PORTA", "8765"))

# Modo do guarda de SQL: "enforce" (recusa), "warn" (só registra), "off".
MODO_GUARDA = os.getenv("G2_SQL_GUARD", "enforce")

# Intervalo de cada rotina, em segundos. Curtos porque o banco é local e a
# demonstração fica mais interessante com o contador girando.
INTERVALOS = {
    "dashboard": 180,
    "vendas": 240,
    "estoque": 300,
    "financeiro": 300,
    "crm": 360,
    "imposto": 420,
    "clientes": 480,
}

# Perfis de acesso: senha → abas liberadas. "*" libera tudo.
# O bloqueio é aplicado no servidor, não só na navegação — é o ponto da
# demonstração: entrar como "vendas" e tentar /dados/financeiro devolve 403.
PERFIS: dict[str, list[str]] = {
    "demo": ["*"],
    "comercial": ["dashboard", "vendas", "crm", "cliente", "clientes"],
    "financeiro": ["dashboard", "financeiro", "imposto", "cliente"],
    "operacao": ["painel_pedidos", "estoque"],
}

# Meta mensal da empresa usada quando não há meta salva.
META_PADRAO = 1_500_000.0

TOKEN_TTL = 8 * 3600
