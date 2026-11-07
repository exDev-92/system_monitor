; Проверка PawnIO при установке.
;
; PawnIO — драйвер, через который читаются температуры, вентиляторы, мощность
; процессора и SMART. Без него приложение работает, но показывает только
; загрузку, память, диски и сеть. Сам установщик PawnIO в пакет не входит:
; pawnio-install.ps1 скачивает его у автора и проверяет подпись.

!macro customInstall
  ${IfNot} ${Silent}
    SetRegView 64
    ClearErrors
    ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Services\PawnIO" "ImagePath"
    ${If} ${Errors}
      MessageBox MB_YESNO|MB_ICONQUESTION "Для температур, вентиляторов и SMART нужен драйвер PawnIO. Он не установлен.$\r$\n$\r$\nСкачать и установить его сейчас? Установщик PawnIO загрузится с официальной страницы автора (github.com/namazso) и попросит права администратора.$\r$\n$\r$\nМожно и позже: Настройки → Датчики." IDNO pawnio_done
      ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\resources\pawnio-install.ps1"' $1
      ClearErrors
      ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Services\PawnIO" "ImagePath"
      ${If} ${Errors}
        MessageBox MB_OK|MB_ICONEXCLAMATION "PawnIO не установлен. Приложение будет работать без температур и вентиляторов.$\r$\n$\r$\nУстановить можно позже: Настройки → Датчики."
      ${EndIf}
    ${EndIf}
    pawnio_done:
    SetRegView default
  ${EndIf}
!macroend
