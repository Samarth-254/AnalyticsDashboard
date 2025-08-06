@echo off
echo 🚀 Starting Multi-Site Test Servers...
echo.
echo Starting servers:
echo - Site 1: http://localhost:8888 (Original site)
echo - Site 2: http://localhost:9999 (E-commerce)  
echo - Site 3: http://localhost:7777 (Blog)
echo.
echo Press Ctrl+C to stop all servers
echo.

start cmd /k "cd /d %~dp0 && echo Starting Site 1 on port 8888... && python -m http.server 8888"
timeout /t 2 /nobreak >nul

start cmd /k "cd /d %~dp0site2 && echo Starting Site 2 on port 9999... && python -m http.server 9999"
timeout /t 2 /nobreak >nul

start cmd /k "cd /d %~dp0site3 && echo Starting Site 3 on port 7777... && python -m http.server 7777"

echo.
echo ✅ All servers started!
echo.
echo Open these URLs to test:
echo   http://localhost:8888  - Analytics Test Site
echo   http://localhost:9999  - E-commerce Store
echo   http://localhost:7777  - Tech Blog
echo.
echo All sites use the same Widget ID: 7c220169-6103-46d9-a0ea-3a1e899128d1
echo.
pause
