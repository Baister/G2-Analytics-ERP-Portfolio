"""Cache dos ciclos dos bots, em SQLite.

Serve a dois propósitos: a interface abre cheia logo após o boot (lendo o
último ciclo salvo, antes de qualquer consulta terminar) e um ciclo que falha
não deixa a tela vazia.

O modo WAL não é enfeite: com ele um leitor não bloqueia o escritor, então a
gravação de um bot nunca trava a leitura de quem está com a tela aberta.
"""
from __future__ import annotations

import json
import logging
import math
import sqlite3
import threading
from datetime import date, datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def limpar_para_json(obj: Any) -> Any:
    """Deixa o payload pronto para `json.dumps` sem surpresa.

    `NaN`/`Infinity` não existem em JSON (viram `NaN` literal, que quebra o
    parser do navegador) e datas não são serializáveis. Esta função é aplicada
    em TODOS os caminhos de resposta da API — foi a ausência dela em um único
    endpoint que gerou um 503 em produção no sistema de origem.
    """
    if isinstance(obj, dict):
        return {k: limpar_para_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [limpar_para_json(v) for v in obj]
    if isinstance(obj, float):
        return None if (math.isnan(obj) or math.isinf(obj)) else obj
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    return obj


class Cache:
    def __init__(self, caminho: str | Path):
        self.caminho = Path(caminho)
        self._lock = threading.Lock()
        self._criar()

    def _conectar(self) -> sqlite3.Connection:
        con = sqlite3.connect(self.caminho, timeout=10)
        # PRAGMAs são idempotentes: repetir a cada conexão não custa nada.
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA synchronous=NORMAL")
        return con

    def _criar(self) -> None:
        self.caminho.parent.mkdir(parents=True, exist_ok=True)
        with self._conectar() as con:
            con.execute(
                "CREATE TABLE IF NOT EXISTS cache ("
                " nome TEXT PRIMARY KEY, dados TEXT NOT NULL, atualizado_em TEXT NOT NULL)"
            )

    def salvar(self, nome: str, dados: dict) -> None:
        payload = json.dumps(limpar_para_json(dados), ensure_ascii=False, default=str)
        agora = datetime.now().isoformat(timespec="seconds")
        with self._lock, self._conectar() as con:
            con.execute(
                "INSERT INTO cache (nome, dados, atualizado_em) VALUES (?,?,?) "
                "ON CONFLICT(nome) DO UPDATE SET dados=excluded.dados,"
                " atualizado_em=excluded.atualizado_em",
                (nome, payload, agora),
            )

    def carregar(self, nome: str) -> dict | None:
        with self._conectar() as con:
            linha = con.execute(
                "SELECT dados FROM cache WHERE nome = ?", (nome,)
            ).fetchone()
        if not linha:
            return None
        try:
            return json.loads(linha[0])
        except json.JSONDecodeError:
            # Entrada corrompida não pode derrubar quem lê: registra e remove,
            # o próximo ciclo do bot reescreve.
            logger.warning("cache de '%s' corrompido — descartando", nome)
            with self._lock, self._conectar() as con:
                con.execute("DELETE FROM cache WHERE nome = ?", (nome,))
            return None

    def quando(self, nome: str) -> str | None:
        with self._conectar() as con:
            linha = con.execute(
                "SELECT atualizado_em FROM cache WHERE nome = ?", (nome,)
            ).fetchone()
        return linha[0][11:19] if linha else None
