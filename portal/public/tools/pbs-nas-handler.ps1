# ============================================================================
#  Установщик обработчика протокола  pbsnas://  для портала ИСМ ПБС
# ----------------------------------------------------------------------------
#  Что делает: регистрирует в Windows (для текущего пользователя, без прав
#  администратора) обработчик ссылок вида  pbsnas://6.7-РТД/ОК/...  — клик по
#  кнопке «📁 NAS» в портале открывает папку проекта в Проводнике.
#
#  Корень хранилища у каждого ПК СВОЙ (синхронизированная папка Synology Drive,
#  сетевой диск или UNC) — поэтому задайте его ниже и запустите скрипт.
#
#  Запуск:  правый клик по файлу → «Выполнить с помощью PowerShell»
#           либо в PowerShell:  powershell -ExecutionPolicy Bypass -File pbs-nas-handler.ps1
# ============================================================================

# >>> 1. УКАЖИТЕ КОРЕНЬ ПАПКИ 06-Записи-ПБС НА ЭТОМ КОМПЬЮТЕРЕ <<<
#     Поле проекта в портале начинается с «6.7-РТД/…», корень дописывается слева.
#     Примеры:
#       'C:\Users\Александр Кирилюк\Documents\Сервер ПБС\06-Записи-ПБС'
#       '\\nas-pbs\06-Записи-ПБС'
#       'Z:\06-Записи-ПБС'
$NasRoot = 'C:\Users\Александр Кирилюк\Documents\Сервер ПБС\06-Записи-ПБС'

# ---------------------------------------------------------------------------
# Ниже менять не нужно.
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'

if (-not (Test-Path $NasRoot)) {
  Write-Warning "Папка не найдена: $NasRoot"
  Write-Warning "Откройте скрипт, поправьте `$NasRoot под этот ПК и запустите снова."
}

$dir = Join-Path $env:LOCALAPPDATA 'PBS'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$resolver = Join-Path $dir 'pbsnas-open.ps1'

# Тело резолвера: получает URI от Windows (%1), отрезает pbsnas://, раскодирует
# %xx (UTF-8), меняет / на \, дописывает корень и открывает папку в Проводнике.
$body = @'
param([string]$uri)
$root = '__NAS_ROOT__'
$rel  = [uri]::UnescapeDataString(($uri -replace '^pbsnas:/*','')) -replace '/','\'
$rel  = $rel.TrimEnd('\')
$full = Join-Path $root $rel
if (Test-Path -LiteralPath $full)                       { Invoke-Item -LiteralPath $full }
elseif (Test-Path -LiteralPath (Split-Path $full -Parent)) { Invoke-Item -LiteralPath (Split-Path $full -Parent) }
elseif (Test-Path -LiteralPath $root)                   { Invoke-Item -LiteralPath $root }
else {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("Папка не найдена:`n$full`n`nПроверьте корень NAS в установщике обработчика.", "ИСМ ПБС") | Out-Null
}
'@
$body = $body.Replace('__NAS_ROOT__', $NasRoot)
Set-Content -Path $resolver -Value $body -Encoding UTF8

# Регистрация протокола pbsnas:// в HKCU (без админ-прав)
$cmd = "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$resolver`" `"%1`""
$key = 'HKCU:\Software\Classes\pbsnas'
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name '(default)'    -Value 'URL:PBS NAS Protocol'
Set-ItemProperty -Path $key -Name 'URL Protocol' -Value ''
New-Item -Path "$key\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$key\shell\open\command" -Name '(default)' -Value $cmd

Write-Host ''
Write-Host 'Готово. Протокол pbsnas:// зарегистрирован для текущего пользователя.' -ForegroundColor Green
Write-Host ("Корень NAS:  " + $NasRoot)
Write-Host ("Резолвер:     " + $resolver)
Write-Host ''
Write-Host 'Теперь кнопка «📁 NAS» в портале открывает папку проекта в Проводнике.'
Write-Host 'Если корень со временем изменится — поправьте $NasRoot и запустите скрипт снова.'
