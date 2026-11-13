@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title 开发者工具箱 - 一键打包

rem Double-click: build both Windows packages, open dist, and keep this window visible.
rem --no-pause: run without prompts or opening Explorer, and return the real exit code.
set "TOOLBOX_PACK_NO_PAUSE=0"
set "TOOLBOX_PACK_PUSHED="
set "TOOLBOX_PACK_EXIT=1"
set "TOOLBOX_PACK_STAGE=检查运行环境"
if /i "%~1"=="--no-pause" set "TOOLBOX_PACK_NO_PAUSE=1"

pushd "%~dp0"
if errorlevel 1 goto location_failed
set "TOOLBOX_PACK_PUSHED=1"
if not exist "package.json" goto location_failed

echo.
echo 开发者工具箱 - 同时生成安装版和绿色版
echo 项目目录："%CD%"
echo 打包期间请勿关闭此窗口。
echo.

where node >nul 2>nul
if errorlevel 1 goto node_missing
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 goto node_missing
node --version

set "TOOLBOX_PACK_PNPM=pnpm"
where pnpm >nul 2>nul
if not errorlevel 1 goto pnpm_ready
set "TOOLBOX_PACK_PNPM=corepack"
where corepack >nul 2>nul
if errorlevel 1 goto pnpm_missing
set "COREPACK_ENABLE_DOWNLOAD_PROMPT=0"

:pnpm_ready
call :run_pnpm --version
set "TOOLBOX_PACK_EXIT=%errorlevel%"
if not "%TOOLBOX_PACK_EXIT%"=="0" goto failed

echo.
echo [1/3] 检查并同步项目依赖，首次运行可能需要下载。
set "TOOLBOX_PACK_STAGE=安装项目依赖"
call :run_pnpm install --frozen-lockfile --prod=false
set "TOOLBOX_PACK_EXIT=%errorlevel%"
if not "%TOOLBOX_PACK_EXIT%"=="0" goto failed

if exist "node_modules\electron\dist\electron.exe" goto electron_ready
echo 正在补齐 Electron 运行文件...
set "TOOLBOX_PACK_STAGE=准备 Electron 运行文件"
node "node_modules\electron\install.js"
set "TOOLBOX_PACK_EXIT=%errorlevel%"
if not "%TOOLBOX_PACK_EXIT%"=="0" goto failed

:electron_ready
echo.
echo [2/3] 准备内置 FFmpeg。
set "TOOLBOX_PACK_STAGE=查找 FFmpeg"
if defined DEV_TOOLBOX_FFMPEG_SOURCE goto ffmpeg_ready
if not exist "resources\ffmpeg\ffmpeg.exe" goto ffmpeg_default
set "DEV_TOOLBOX_FFMPEG_SOURCE=%CD%\resources\ffmpeg\ffmpeg.exe"
goto ffmpeg_ready

:ffmpeg_default
if not exist "D:\code\my\1\dev_toolbox\assets\ffmpeg\ffmpeg.exe" goto ffmpeg_path
set "DEV_TOOLBOX_FFMPEG_SOURCE=D:\code\my\1\dev_toolbox\assets\ffmpeg\ffmpeg.exe"
goto ffmpeg_ready

:ffmpeg_path
for /f "delims=" %%F in ('where ffmpeg.exe 2^>nul') do if not defined DEV_TOOLBOX_FFMPEG_SOURCE set "DEV_TOOLBOX_FFMPEG_SOURCE=%%F"
if defined DEV_TOOLBOX_FFMPEG_SOURCE goto ffmpeg_ready
if "%TOOLBOX_PACK_NO_PAUSE%"=="1" goto ffmpeg_missing
echo 未找到 FFmpeg，请将 ffmpeg.exe 拖入此窗口后按回车；直接回车取消。
set "TOOLBOX_PACK_FFMPEG_INPUT="
set /p "TOOLBOX_PACK_FFMPEG_INPUT=FFmpeg 路径："
if not defined TOOLBOX_PACK_FFMPEG_INPUT goto ffmpeg_missing
set "DEV_TOOLBOX_FFMPEG_SOURCE=%TOOLBOX_PACK_FFMPEG_INPUT:"=%"

:ffmpeg_ready
if not exist "%DEV_TOOLBOX_FFMPEG_SOURCE%" goto ffmpeg_missing
echo 使用 FFmpeg："%DEV_TOOLBOX_FFMPEG_SOURCE%"
echo.
echo [3/3] 校验、构建并打包，生成安装版和绿色版。
set "TOOLBOX_PACK_STAGE=构建和打包"
if "%TOOLBOX_PACK_PNPM%"=="corepack" goto corepack_build
call :run_pnpm run dist --publish never
set "TOOLBOX_PACK_EXIT=%errorlevel%"
if not "%TOOLBOX_PACK_EXIT%"=="0" goto failed
goto package_done

:corepack_build
rem dist invokes pnpm internally. Use the equivalent steps when only Corepack is on PATH.
set "TOOLBOX_PACK_STAGE=校验 FFmpeg"
call :run_pnpm run ffmpeg:prepare
set "TOOLBOX_PACK_EXIT=%errorlevel%"
if not "%TOOLBOX_PACK_EXIT%"=="0" goto failed
set "TOOLBOX_PACK_STAGE=类型检查和构建"
call :run_pnpm run build
set "TOOLBOX_PACK_EXIT=%errorlevel%"
if not "%TOOLBOX_PACK_EXIT%"=="0" goto failed
set "TOOLBOX_PACK_STAGE=生成安装版和绿色版"
call :run_pnpm exec electron-builder --publish never
set "TOOLBOX_PACK_EXIT=%errorlevel%"
if not "%TOOLBOX_PACK_EXIT%"=="0" goto failed

:package_done
echo.
echo 打包成功！
echo 安装版和绿色版位于："%CD%\dist"
if "%TOOLBOX_PACK_NO_PAUSE%"=="1" goto finish
start "" "%CD%\dist"
goto finish

:location_failed
echo 无法进入项目目录。请将此 BAT 放在 package.json 所在的项目根目录。
set "TOOLBOX_PACK_EXIT=1"
goto failed

:node_missing
echo 需要 Node.js 24 或更高版本。请安装后重新双击此文件。
echo 下载地址：https://nodejs.org/
set "TOOLBOX_PACK_EXIT=1"
goto failed

:pnpm_missing
echo 未找到 pnpm 或 Corepack，请先安装项目要求的 pnpm 后重试。
echo 版本要求见 package.json 的 packageManager 字段。
set "TOOLBOX_PACK_EXIT=1"
goto failed

:ffmpeg_missing
echo 未找到可用的 ffmpeg.exe。
echo 可将其放入项目的 resources\ffmpeg 目录，或设置 DEV_TOOLBOX_FFMPEG_SOURCE。
set "TOOLBOX_PACK_EXIT=1"

:failed
echo.
echo 打包未完成，失败步骤：%TOOLBOX_PACK_STAGE%，退出码：%TOOLBOX_PACK_EXIT%
echo 请查看上方错误信息。修复后可重新双击运行。
echo 若文件被占用，请手动关闭正在运行的打包产物后重试。

:finish
if defined TOOLBOX_PACK_PUSHED popd
if "%TOOLBOX_PACK_NO_PAUSE%"=="0" pause
exit /b %TOOLBOX_PACK_EXIT%

:run_pnpm
if "%TOOLBOX_PACK_PNPM%"=="corepack" goto run_corepack
call pnpm %*
exit /b %errorlevel%

:run_corepack
call corepack pnpm %*
exit /b %errorlevel%
