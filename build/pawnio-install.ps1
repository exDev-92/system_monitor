# Скачивает официальный установщик PawnIO и запускает его с правами администратора.
#
# PawnIO — драйвер, через который LibreHardwareMonitor читает температуры,
# вентиляторы и SMART. Его установщик не кладётся в наш пакет: права на его
# распространение не подтверждены, поэтому он берётся с адреса автора в момент
# установки, а подпись проверяется перед запуском.
#
# -CheckOnly  скачать и проверить подпись, не запуская (для проверки скрипта)
# Код выхода: код установщика PawnIO; 1 — не удалось скачать или подпись неверна.

param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$Url = 'https://github.com/namazso/PawnIO.Setup/releases/latest/download/PawnIO_setup.exe'
$File = Join-Path $env:TEMP 'PawnIO_setup.exe'

function Show-Error([string]$text) {
    if ($CheckOnly) { Write-Output "ошибка: $text"; return }
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($text, 'Мониторинг ПК', 'OK', 'Warning')
}

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $Url -OutFile $File -UseBasicParsing
} catch {
    Show-Error "Не удалось скачать установщик PawnIO:`n$($_.Exception.Message)`n`nУстановить вручную: https://pawnio.eu"
    exit 1
}

$Signature = Get-AuthenticodeSignature -FilePath $File
$Signer = if ($Signature.SignerCertificate) { $Signature.SignerCertificate.Subject } else { '' }
# Действительной подписи мало: проверяем, что подписал именно автор PawnIO.
if ($Signature.Status -ne 'Valid' -or $Signer -notmatch 'O=namazso') {
    Remove-Item $File -Force -ErrorAction SilentlyContinue
    Show-Error "Установщик PawnIO не прошёл проверку цифровой подписи ($($Signature.Status), $Signer). Запуск отменён.`n`nУстановить вручную: https://pawnio.eu"
    exit 1
}

if ($CheckOnly) {
    Write-Output "подпись: $($Signature.Status); подписал: $Signer; размер: $((Get-Item $File).Length)"
    Remove-Item $File -Force -ErrorAction SilentlyContinue
    exit 0
}

try {
    $Process = Start-Process -FilePath $File -Verb RunAs -Wait -PassThru
    $Code = $Process.ExitCode
} catch {
    # Отказ в запросе прав администратора тоже попадает сюда
    $Code = 1223
}
Remove-Item $File -Force -ErrorAction SilentlyContinue
exit $Code
