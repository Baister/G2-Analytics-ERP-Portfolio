@echo off
title G2 Analytics - demonstracao
cd /d "%~dp0"

echo ====================================================
echo   G2 Analytics - ambiente de demonstracao
echo ====================================================
echo.

rem == Pre-requisitos =================================
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERRO] Python nao encontrado no PATH.
    echo Instale o Python 3.11+ marcando "Add python.exe to PATH".
    pause
    exit /b 1
)
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERRO] Node.js nao encontrado no PATH. Instale o Node 20+.
    pause
    exit /b 1
)

rem == Dependencias Python ============================
python -c "import fastapi, uvicorn, pandas" >nul 2>&1
if errorlevel 1 (
    echo Instalando dependencias Python ^(so na primeira vez^)...
    python -m pip install -r api\requirements.txt
    if errorlevel 1 (
        echo [ERRO] Falha ao instalar dependencias Python.
        pause
        exit /b 1
    )
    echo.
)

rem == Banco sintetico ================================
if not exist "api\dados\demo.db" (
    echo Gerando o banco de demonstracao ^(13 meses de operacao ficticia^)...
    pushd api
    python -m dados.gerar
    popd
    echo.
)

rem == Dependencias e build do front ==================
if not exist "web\node_modules" (
    echo Instalando dependencias do front ^(alguns minutos, so na primeira vez^)...
    pushd web
    call npm install --no-audit --no-fund
    popd
    echo.
)
if not exist "web\.output\server\index.mjs" (
    echo Gerando o build do front ^(1-2 min^)...
    pushd web
    call npm run build
    popd
    echo.
)

rem == Encerra instancias antigas nas portas do projeto ==
echo Encerrando instancias antigas, se existirem...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8765,8790 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }" >nul 2>&1
timeout /t 4 /nobreak >nul

echo Iniciando a API (porta 8765)...
start "G2 Demo - API" cmd /k "cd /d %~dp0api && python server.py"

echo Iniciando o front (porta 8790)...
start "G2 Demo - Front" cmd /k "cd /d %~dp0web && set PORT=8790&& npm start"

echo.
echo ====================================================
echo   Pronto! Abra:  http://localhost:8790
echo.
echo   Senhas de acesso (cada uma libera abas diferentes):
echo     demo        - todas as abas
echo     comercial   - dashboard, vendas, CRM e clientes
echo     financeiro  - dashboard, financeiro, imposto
echo     operacao    - painel de pedidos e estoque
echo ====================================================
echo.
pause >nul
