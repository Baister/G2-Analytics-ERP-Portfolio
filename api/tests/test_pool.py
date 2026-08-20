"""Testes do pool — exercitado com conexão falsa, sem banco nenhum.

É essa injeção de `factory` que torna o pool testável: dá para simular
esgotamento, conexão morta e falha na abertura sem depender de infraestrutura.
"""
from __future__ import annotations

import threading
import time

import pytest

from core.pool import ConnectionPool, PoolEsgotado


class ConexaoFalsa:
    def __init__(self, id_: int, saudavel: bool = True):
        self.id = id_
        self.saudavel = saudavel
        self.fechada = False

    def close(self):
        self.fechada = True


def fabrica(contador: list[int]):
    def _criar():
        contador.append(1)
        return ConexaoFalsa(len(contador))
    return _criar


def checar(conn: ConexaoFalsa) -> None:
    if not conn.saudavel:
        raise RuntimeError("conexão morta")


def test_reusa_a_mesma_conexao():
    criadas: list[int] = []
    pool = ConnectionPool(fabrica(criadas), cap=4)
    c1 = pool.acquire()
    pool.release(c1)
    c2 = pool.acquire()
    assert c1 is c2, "devia ter reutilizado a conexão ociosa"
    assert len(criadas) == 1


def test_lifo_devolve_a_mais_quente():
    criadas: list[int] = []
    pool = ConnectionPool(fabrica(criadas), cap=4)
    a, b = pool.acquire(), pool.acquire()
    pool.release(a)
    pool.release(b)  # b foi devolvida por último
    assert pool.acquire() is b


def test_respeita_o_teto_e_expira_a_espera():
    pool = ConnectionPool(fabrica([]), cap=2, wait_s=0.2)
    pool.acquire()
    pool.acquire()
    inicio = time.time()
    with pytest.raises(PoolEsgotado, match="esgotado"):
        pool.acquire()
    assert time.time() - inicio >= 0.2, "devia ter esperado antes de desistir"


def test_espera_liberar_vaga_em_vez_de_falhar():
    pool = ConnectionPool(fabrica([]), cap=1, wait_s=5)
    primeira = pool.acquire()

    def devolver_depois():
        time.sleep(0.15)
        pool.release(primeira)

    threading.Thread(target=devolver_depois, daemon=True).start()
    assert pool.acquire() is primeira  # conseguiu depois da devolução


def test_conexao_quebrada_nao_volta_para_o_pool():
    criadas: list[int] = []
    pool = ConnectionPool(fabrica(criadas), cap=2)
    c = pool.acquire()
    pool.release(c, quebrada=True)
    assert c.fechada
    assert pool.abertas == 0
    nova = pool.acquire()
    assert nova is not c


def test_descarta_ociosa_que_falha_no_health_check():
    criadas: list[int] = []
    pool = ConnectionPool(fabrica(criadas), cap=2, health_check=checar)
    c = pool.acquire()
    pool.release(c)
    # Envelhece a devolução para além da janela de confiança de 5s.
    pool._idle[-1] = (c, time.time() - 10)
    c.saudavel = False
    nova = pool.acquire()
    assert nova is not c
    assert c.fechada, "a conexão morta devia ter sido fechada"


def test_confia_em_devolucao_recente_sem_health_check():
    """Conexão devolvida há menos de 5s é reutilizada sem round-trip."""
    chamadas: list[int] = []

    def check_contando(conn):
        chamadas.append(1)

    pool = ConnectionPool(fabrica([]), cap=2, health_check=check_contando)
    c = pool.acquire()
    pool.release(c)
    pool.acquire()
    assert not chamadas, "não devia ter feito health-check numa devolução quente"


def test_colhe_ociosas_expiradas():
    criadas: list[int] = []
    pool = ConnectionPool(fabrica(criadas), cap=3, max_idle_s=0.05)
    c = pool.acquire()
    pool.release(c)
    time.sleep(0.1)
    pool.acquire()  # a colheita acontece dentro do próprio acquire
    assert c.fechada
    assert len(criadas) == 2


def test_falha_na_abertura_libera_a_vaga():
    """Se a factory explode, a vaga reservada tem de voltar — senão o pool encolhe."""
    tentativas: list[int] = []

    def fabrica_ruim():
        tentativas.append(1)
        raise ConnectionError("banco fora do ar")

    pool = ConnectionPool(fabrica_ruim, cap=1, wait_s=0.2)
    for _ in range(3):
        with pytest.raises(ConnectionError):
            pool.acquire()
    assert len(tentativas) == 3, "a 2ª e a 3ª tentativas não acharam vaga livre"
    assert pool.abertas == 0


def test_close_all_zera_o_pool():
    pool = ConnectionPool(fabrica([]), cap=3)
    a, b = pool.acquire(), pool.acquire()
    pool.release(a)
    pool.release(b)
    pool.close_all()
    assert pool.abertas == 0 and pool.ociosas == 0
    assert a.fechada and b.fechada


def test_uso_concorrente_nao_estoura_o_teto():
    criadas: list[int] = []
    pool = ConnectionPool(fabrica(criadas), cap=4, wait_s=5)
    erros: list[Exception] = []

    def trabalhar():
        try:
            for _ in range(20):
                c = pool.acquire()
                time.sleep(0.001)
                pool.release(c)
        except Exception as e:  # pragma: no cover
            erros.append(e)

    threads = [threading.Thread(target=trabalhar) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not erros
    assert len(criadas) <= 4, f"abriu {len(criadas)} conexões para um teto de 4"
