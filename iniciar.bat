@echo off
cd /d "%~dp0"
echo ===================================================
echo           Iniciando IRIS (NavegadorBeta)
echo ===================================================

if not exist "node_modules" (
    echo [INFO] Primera ejecucion detectada.
    echo [INFO] Instalando dependencias de Node.js...
    call npm install
    if errorlevel 1 (
        echo [ERROR] Fallo al instalar dependencias.
        pause
        exit /b %errorlevel%
    )
)

echo [INFO] Compilando e iniciando la aplicacion...
call npm run dev
if errorlevel 1 (
    echo [ERROR] Ocurrio un error al ejecutar la aplicacion.
    pause
)
