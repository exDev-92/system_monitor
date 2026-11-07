"""Встроенный источник датчиков поверх LibreHardwareMonitorLib.

Библиотека приходит вместе с пакетом `HardwareMonitor` (pip) и работает через
драйвер PawnIO — подписанный Microsoft, в отличие от старого WinRing0, который
даёт произвольный ring0-доступ и лежит в блок-листе уязвимых драйверов.

Процесс должен быть запущен от имени администратора: без этого структура
датчиков видна, но все значения приходят пустыми (PawnIO не отдаёт MSR).
"""

import ctypes
from typing import NamedTuple


class Sensor(NamedTuple):
    """Форма, совместимая с WMI-объектами LibreHardwareMonitor.

    Hardware/HardwareType есть только у встроенного источника — у WMI-объектов
    их нет, поэтому читать эти поля нужно через getattr с запасным значением.
    """
    SensorType: str
    Name: str
    Identifier: str
    Value: float | None
    Hardware: str = ''
    HardwareType: str = ''


_computer = None
_opened = False
_import_error: str | None = None
_open_error: str | None = None


def is_elevated() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def open_computer() -> bool:
    """Открывает LibreHardwareMonitorLib. Повторные вызовы безопасны."""
    global _computer, _opened, _import_error, _open_error

    if _opened:
        return True
    if _import_error is not None or _open_error is not None:
        return False

    try:
        from HardwareMonitor.Hardware import Computer
    except Exception as e:
        _import_error = f"{type(e).__name__}: {e}"
        return False

    try:
        computer = Computer()
        computer.IsCpuEnabled = True
        computer.IsGpuEnabled = True
        computer.IsMemoryEnabled = True
        computer.IsMotherboardEnabled = True
        computer.IsStorageEnabled = True
        computer.IsControllerEnabled = True
        computer.Open()
    except Exception as e:
        _open_error = f"{type(e).__name__}: {e}"
        return False

    _computer = computer
    _opened = True
    return True


def _collect(hardware, out: list, root_name: str = '', root_type: str = '', update: bool = True) -> None:
    # Без Update() значения остаются от прошлого чтения: к устройству при этом
    # никто не обращается, и спящий жёсткий диск не просыпается.
    if update:
        try:
            hardware.Update()
        except Exception:
            return

    name = root_name or str(hardware.Name)
    hw_type = root_type or str(hardware.HardwareType)

    for s in hardware.Sensors:
        try:
            value = s.Value
            out.append(Sensor(
                SensorType=str(s.SensorType),
                Name=str(s.Name),
                Identifier=str(s.Identifier),
                Value=None if value is None else float(value),
                Hardware=name,
                HardwareType=hw_type,
            ))
        except Exception:
            continue

    for sub in hardware.SubHardware:
        _collect(sub, out, name, hw_type, update)


def read_sensors(should_update_storage=None) -> list:
    """Все датчики одним списком. Пустой список — источник недоступен.

    should_update_storage(имя накопителя) -> bool решает, читать ли SMART
    накопителя на этом опросе; без него читаются все.
    """
    if not open_computer():
        return []

    sensors: list = []
    try:
        for hardware in _computer.Hardware:
            update = True
            if should_update_storage is not None and str(hardware.HardwareType) == 'Storage':
                try:
                    update = bool(should_update_storage(str(hardware.Name)))
                except Exception:
                    update = True
            _collect(hardware, sensors, update=update)
    except Exception:
        return []
    return sensors


def hardware_names() -> dict:
    """{тип железа: [имена]} — для сопоставления накопителей с буквами томов."""
    if not open_computer():
        return {}
    result: dict = {}
    try:
        for hw in _computer.Hardware:
            result.setdefault(str(hw.HardwareType), []).append(str(hw.Name))
    except Exception:
        pass
    return result


def status() -> dict:
    return {
        'available': _opened,
        'elevated': is_elevated(),
        'error': _import_error or _open_error,
    }


def close() -> None:
    global _computer, _opened
    if _computer is not None:
        try:
            _computer.Close()
        except Exception:
            pass
    _computer = None
    _opened = False
