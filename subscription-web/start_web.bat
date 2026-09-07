@echo off
chcp 65001 >nul
title Сбер.Сканер Подписок

echo Запуск Сбер.Сканер Подписок...
echo.

REM 1) Если сервер ещё не запущен - поднимаем его
powershell -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri 'http://127.0.0.1:8000/api/health' -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
    echo Поднимаем сервер http://127.0.0.1:8000 ...
    start "Сканер Подписок - сервер" /min cmd /c "cd /d c:\Python\subscription-web\backend && python -m uvicorn main:app --host 127.0.0.1 --port 8000"
)

REM 2) Ждём, пока сервер ответит (до ~15 секунд)
set /a tries=0
:wait
powershell -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri 'http://127.0.0.1:8000/api/health' -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 goto up
set /a tries+=1
if %tries% GEQ 15 (
    echo.
    echo [ОШИБКА] Сервер не отвечает на http://127.0.0.1:8000
    echo Проверьте: backend\server.log или запустите python -m uvicorn main:app --port 8000
    pause
    exit /b 1
)
timeout /t 1 /nobreak >nul
goto wait

:up
echo Сервер готов.
echo Открываем страницу в браузере...
start http://127.0.0.1:8000

echo.
echo Готово! Страница: http://127.0.0.1:8000
echo (сервер работает в свёрнутом окне; закройте его, чтобы остановить)
timeout /t 5 >nul