import sys
from pathlib import Path

import pytest

# A suíte roda a partir de api/ — garante que `core`, `bots` e `dados` importam.
API = Path(__file__).resolve().parent.parent
if str(API) not in sys.path:
    sys.path.insert(0, str(API))


@pytest.fixture(scope="session")
def banco_demo(tmp_path_factory) -> Path:
    """Gera um banco sintético pequeno, uma vez por sessão de testes."""
    from dados import gerar as g

    destino = tmp_path_factory.mktemp("dados") / "demo_teste.db"
    # Semente diferente da oficial: os testes não podem depender dos números
    # exatos do banco de demonstração distribuído.
    g.gerar(caminho=destino, semente=12345)
    return destino


@pytest.fixture
def db(banco_demo):
    from core.db import Database

    banco = Database(banco_demo)
    yield banco
    banco.fechar()
