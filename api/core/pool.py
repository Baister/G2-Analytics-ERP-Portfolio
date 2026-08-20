"""Pool de conexões genérico, sem thread de manutenção.

Escrito para um cenário concreto: sete rotinas de análise consultando o mesmo
banco em paralelo, com picos de vinte e poucas conexões simultâneas e um
servidor que não deveria ser inundado. As decisões abaixo saíram de problemas
reais, não de teoria — e cada uma está comentada no ponto onde importa.

O pool não conhece o driver: recebe uma `factory` que devolve uma conexão. É
por isso que os testes o exercitam com uma conexão falsa, sem banco nenhum.
"""
from __future__ import annotations

import threading
import time
from typing import Callable


class PoolEsgotado(RuntimeError):
    """Não havia vaga no pool dentro do tempo de espera."""


class ConnectionPool:
    """Pool LIFO com colheita de ociosas no próprio acquire/release.

    Sem thread dedicada de limpeza: uma thread a mais só para varrer conexões
    ociosas é complexidade que pode morrer silenciosamente. A colheita acontece
    quando alguém já está segurando o lock de qualquer forma.

    LIFO em vez de FIFO porque a conexão devolvida por último é a mais "quente"
    — tem mais chance de continuar viva do lado do servidor.
    """

    def __init__(
        self,
        factory: Callable[[], object],
        *,
        cap: int = 8,
        max_idle_s: float = 300.0,
        wait_s: float = 30.0,
        health_check: Callable[[object], None] | None = None,
    ):
        self._factory = factory
        self._cap = cap
        self._max_idle = max_idle_s
        self._wait_s = wait_s
        self._health_check = health_check
        # Condition PRÓPRIA do pool: ele nunca disputa lock com outra camada,
        # então uma consulta lenta em outro caminho não trava a fila daqui.
        self._cond = threading.Condition()
        self._idle: list[tuple[object, float]] = []  # (conexão, devolvida_em)
        self._n_abertas = 0  # ociosas + emprestadas

    # ── estatísticas (usadas em teste e no endpoint de saúde) ──────────────
    @property
    def abertas(self) -> int:
        with self._cond:
            return self._n_abertas

    @property
    def ociosas(self) -> int:
        with self._cond:
            return len(self._idle)

    # ── internos ───────────────────────────────────────────────────────────
    def _colher(self) -> None:
        """Fecha ociosas velhas. SEMPRE chamado com self._cond em mãos."""
        agora = time.time()
        vivas = []
        for conn, devolvida_em in self._idle:
            if agora - devolvida_em > self._max_idle:
                self._fechar(conn)
                self._n_abertas -= 1
            else:
                vivas.append((conn, devolvida_em))
        self._idle = vivas

    @staticmethod
    def _fechar(conn) -> None:
        try:
            conn.close()
        except Exception:
            pass  # conexão já morta não é problema nosso

    def _saudavel(self, conn, devolvida_em: float) -> bool:
        # Devolvida há menos de 5s: confiar sem pagar o round-trip. O ganho é
        # real quando o pool gira rápido — o custo de um health-check por
        # aquisição aparece no tempo de resposta.
        if time.time() - devolvida_em < 5:
            return True
        if self._health_check is None:
            return True
        try:
            self._health_check(conn)
            return True
        except Exception:
            return False

    # ── API ────────────────────────────────────────────────────────────────
    def acquire(self):
        """Devolve uma conexão pronta. Levanta `PoolEsgotado` se estourar a espera."""
        limite = time.time() + self._wait_s
        while True:
            candidata = None
            criar = False
            with self._cond:
                self._colher()
                if self._idle:
                    candidata = self._idle.pop()  # LIFO: a mais quente
                elif self._n_abertas < self._cap:
                    # Reserva a vaga agora, mas conecta FORA do lock: abrir
                    # conexão pode levar segundos e travaria todo mundo.
                    self._n_abertas += 1
                    criar = True
                else:
                    restante = limite - time.time()
                    if restante <= 0:
                        raise PoolEsgotado(
                            f"pool esgotado ({self._cap} conexões) após "
                            f"{self._wait_s:.0f}s de espera"
                        )
                    self._cond.wait(restante)
                    continue

            if criar:
                try:
                    return self._factory()
                except Exception:
                    # A vaga reservada tem de voltar, senão o pool encolhe a
                    # cada falha até parar de atender.
                    with self._cond:
                        self._n_abertas -= 1
                        self._cond.notify()
                    raise

            conn, devolvida_em = candidata
            if self._saudavel(conn, devolvida_em):
                return conn
            self._fechar(conn)
            with self._cond:
                self._n_abertas -= 1
                self._cond.notify()
            # volta ao topo: pega outra ociosa ou abre uma nova

    def release(self, conn, *, quebrada: bool = False) -> None:
        """Devolve a conexão. `quebrada=True` descarta em vez de reciclar."""
        with self._cond:
            if quebrada:
                self._fechar(conn)
                self._n_abertas -= 1
            else:
                self._idle.append((conn, time.time()))
            self._colher()
            self._cond.notify()

    def close_all(self) -> None:
        with self._cond:
            for conn, _ in self._idle:
                self._fechar(conn)
                self._n_abertas -= 1
            self._idle = []
            self._cond.notify_all()
