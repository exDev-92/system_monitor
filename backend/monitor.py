import re
import sys
import json
import time
import socket
import psutil
import platform
import subprocess
from datetime import datetime
from collections import deque

# ── pynvml (NVIDIA GPU) ────────────────────────────────────────
try:
    import pynvml
    pynvml.nvmlInit()
    _nvml_handle = pynvml.nvmlDeviceGetHandleByIndex(0)
    NVML_AVAILABLE = True
except Exception:
    NVML_AVAILABLE = False
    _nvml_handle = None

# ── WMI ACPI (fallback CPU temp) ──────────────────────────────
_wmi_acpi = None
_wmi_acpi_tried = False

def _ensure_wmi_acpi():
    global _wmi_acpi, _wmi_acpi_tried
    if _wmi_acpi_tried:
        return _wmi_acpi
    _wmi_acpi_tried = True
    try:
        import wmi as _wmilib
        _wmi_acpi = _wmilib.WMI(namespace="root\\wmi")
    except Exception:
        _wmi_acpi = None
    return _wmi_acpi

# ── LibreHardwareMonitor ───────────────────────────────────────
# Основной источник — встроенная LibreHardwareMonitorLib через PawnIO (lhm.py).
# Запасной — WMI внешнего LibreHardwareMonitor, если он запущен.
try:
    import lhm as _lhm_embedded
except Exception:
    try:
        from . import lhm as _lhm_embedded  # type: ignore
    except Exception:
        _lhm_embedded = None

# ── Жёсткие диски ──────────────────────────────────────────────
# Чтение SMART выполняет сам диск: опрос раз в секунду не даёт HDD уснуть,
# а у дисков с агрессивной парковкой головок (WD Green) вызывает щелчки и износ.
#   active — читать, только когда к диску и так обращаются (не чаще раза в 5 мин)
#   always — на каждом опросе, как раньше
#   never  — не читать вовсе
HDD_POLL = 'active'
if '--hdd-poll' in sys.argv:
    try:
        _arg = sys.argv[sys.argv.index('--hdd-poll') + 1]
        if _arg in ('active', 'always', 'never'):
            HDD_POLL = _arg
    except IndexError:
        pass

_HDD_MIN_INTERVAL = 300.0
_FREE_REFRESH = 1800.0
_PARTITIONS_REFRESH = 60.0

_drive_info_cache: dict | None = None    # {имя модели: {'index', 'kind'}}
_hdd_last_read: dict = {}                # номер диска -> время чтения SMART
_hdd_io_prev: dict = {}                  # номер диска -> (байт прочитано, записано)
_hdd_active: dict = {}                   # номер диска -> было ли обращение за опрос
_hdd_asleep: dict = {}                   # номер диска -> диск остановлен
_hdd_read_last: set = set()              # чьи SMART читали на прошлом опросе
_hdd_read_now: set = set()


def _query_drive_info() -> dict:
    """Тип физических дисков по Storage Management API Windows.

    MediaType: 3 — HDD, 4 — SSD, 0 — не указан. WD Green, например, приходит
    с нулём и с SpindleSpeed 0, хотя шпиндель у него есть, — этому полю верить
    нельзя. Неуказанный тип считаем жёстким диском, если это не NVMe (BusType 17):
    ошибка в эту сторону стоит лишь редкого обновления температуры у SSD.
    """
    result: dict = {}
    if platform.system() != 'Windows':
        return result
    try:
        import wmi as _wmilib
        c = _wmilib.WMI(namespace='root\\Microsoft\\Windows\\Storage')
        for d in c.MSFT_PhysicalDisk():
            name = (d.FriendlyName or '').strip()
            try:
                index = int(d.DeviceId)
            except Exception:
                continue
            media = int(d.MediaType or 0)
            bus = int(d.BusType or 0)
            kind = 'ssd' if media == 4 or bus == 17 else 'hdd'
            result[name] = {'index': index, 'kind': kind}
    except Exception:
        pass
    return result


def drive_info() -> dict:
    global _drive_info_cache
    if _drive_info_cache is None:
        _drive_info_cache = _query_drive_info()
    return _drive_info_cache


def _drive_kind_by_index(index) -> str | None:
    for info in drive_info().values():
        if info['index'] == index:
            return info['kind']
    return None


def drive_spinning(index: int) -> bool | None:
    """Раскручен ли диск. GetDevicePowerState по документации диск не будит.

    None — состояние неизвестно (нет прав или контроллер не отвечает).
    """
    if platform.system() != 'Windows':
        return None
    try:
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.WinDLL('kernel32', use_last_error=True)
        k32.CreateFileW.restype = wintypes.HANDLE
        k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                    wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        k32.GetDevicePowerState.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
        k32.CloseHandle.argtypes = [wintypes.HANDLE]
        # Доступ 0: только запрос состояния, без чтения с носителя
        handle = k32.CreateFileW(f'\\\\.\\PhysicalDrive{index}', 0, 3, None, 3, 0, None)
        if handle in (None, wintypes.HANDLE(-1).value):
            return None
        try:
            on = wintypes.BOOL()
            if not k32.GetDevicePowerState(handle, ctypes.byref(on)):
                return None
            return bool(on.value)
        finally:
            k32.CloseHandle(handle)
    except Exception:
        return None


def _hdd_tick() -> None:
    """Перед опросом: какие жёсткие диски спят и к каким были обращения.

    Счётчики чтения и записи ведёт Windows — к самому диску они не обращаются.
    Обращение на опросе сразу после нашего чтения SMART не засчитываем:
    иначе программа будила бы диск сама себе.
    """
    global _hdd_read_last, _hdd_read_now
    _hdd_read_last, _hdd_read_now = _hdd_read_now, set()

    try:
        counters = psutil.disk_io_counters(perdisk=True)
    except Exception:
        counters = {}

    for info in drive_info().values():
        if info['kind'] != 'hdd':
            continue
        index = info['index']
        cur = counters.get(f'PhysicalDrive{index}')
        io_now = (cur.read_bytes, cur.write_bytes) if cur else None
        prev = _hdd_io_prev.get(index)
        _hdd_io_prev[index] = io_now
        _hdd_active[index] = (
            io_now is not None and prev is not None and io_now != prev
            and index not in _hdd_read_last
        )
        _hdd_asleep[index] = drive_spinning(index) is False


def _should_read_storage(name: str) -> bool:
    info = drive_info().get(name.strip())
    if not info or info['kind'] != 'hdd':
        return True

    index = info['index']
    if HDD_POLL == 'never' or _hdd_asleep.get(index):
        return False
    if HDD_POLL == 'active':
        if not _hdd_active.get(index):
            return False
        if time.time() - _hdd_last_read.get(index, 0.0) < _HDD_MIN_INTERVAL:
            return False

    _hdd_last_read[index] = time.time()
    _hdd_read_now.add(index)
    return True


_lhm_wmi = None
_lhm_last_try: float = 0.0
_LHM_RETRY = 30.0
_lhm_sensors: list = []
_lhm_source: str = 'none'


def refresh_lhm_sensors():
    global _lhm_wmi, _lhm_last_try, _lhm_sensors, _lhm_source

    if _lhm_embedded is not None:
        _hdd_tick()
        sensors = _lhm_embedded.read_sensors(_should_read_storage)
        if sensors:
            _lhm_sensors = sensors
            _lhm_source = 'embedded'
            return

    now = time.time()
    if _lhm_wmi is None:
        if now - _lhm_last_try < _LHM_RETRY:
            _lhm_sensors = []
            return
        _lhm_last_try = now
        try:
            import wmi as _wmilib
            w = _wmilib.WMI(namespace="root\\LibreHardwareMonitor")
            list(w.Sensor())
            _lhm_wmi = w
        except Exception:
            _lhm_sensors = []
            return
    try:
        _lhm_sensors = list(_lhm_wmi.Sensor())
        _lhm_source = 'wmi'
    except Exception:
        _lhm_wmi = None
        _lhm_sensors = []
        _lhm_source = 'none'


def _lhm_find(sensor_type: str, name_kw: str | None, ident_kw: str | None) -> float | None:
    for s in _lhm_sensors:
        if s.SensorType != sensor_type:
            continue
        if name_kw and name_kw.lower() not in s.Name.lower():
            continue
        if ident_kw and ident_kw.lower() not in s.Identifier.lower():
            continue
        try:
            return round(float(s.Value), 1)
        except Exception:
            pass
    return None


def _lhm_exact(sensor_type: str, name: str, ident_kw: str | None = None) -> float | None:
    """Точное совпадение по имени датчика — «Core Max», «CPU Package» и т. п."""
    lname = name.lower()
    for s in _lhm_sensors:
        if s.SensorType != sensor_type or s.Name.lower() != lname:
            continue
        if ident_kw and ident_kw.lower() not in s.Identifier.lower():
            continue
        try:
            return round(float(s.Value), 1)
        except Exception:
            pass
    return None

# ── Poll interval ──────────────────────────────────────────────
# Дизайн допускает 500–1000 мс; значение уходит в UI как есть.
POLL_INTERVAL = 1.0
# Период задаёт главный процесс из настроек: python monitor.py --poll-ms 2000
if '--poll-ms' in sys.argv:
    try:
        POLL_INTERVAL = max(0.1, int(sys.argv[sys.argv.index('--poll-ms') + 1]) / 1000)
    except (IndexError, ValueError):
        pass

# ── Rolling history ────────────────────────────────────────────
cpu_history: deque = deque([0] * 60, maxlen=60)
gpu_history: deque = deque([0] * 60, maxlen=60)

_prev_net_io = None
_prev_disk_io = None
_prev_perdisk_io = None

# Фактический интервал между опросами по каждому счётчику. Цикл спит
# POLL_INTERVAL, но сбор данных (WMI, LHM, ping) занимает ещё столько же —
# делить дельту на номинальный интервал значит завышать скорости вдвое.
_rate_clock: dict = {}
_cpu_name_cache: str | None = None
_ram_hw_cache: dict | None = None
_os_info_cache: str | None = None
_motherboard_cache: str | None = None
_disk_map_cache: dict | None = None
_partitions_cache: tuple = (0.0, [])
_usage_cache: dict = {}   # точка монтирования -> (usage, время, байт записано на диск)
_fan_peak: dict = {}

# ── Latency cache ──────────────────────────────────────────────
_latency_cache: int = 0
_latency_last_check: float = 0.0
_LATENCY_INTERVAL = 5.0

# ── Маршрут по умолчанию ───────────────────────────────────────
_route_cache: tuple | None = None
_route_last_check: float = 0.0
_ROUTE_INTERVAL = 30.0


def get_cpu_name() -> str:
    global _cpu_name_cache
    if _cpu_name_cache:
        return _cpu_name_cache
    try:
        if platform.system() == 'Windows':
            result = subprocess.run(
                ['wmic', 'cpu', 'get', 'Name', '/format:list'],
                capture_output=True, text=True, timeout=3,
                encoding='oem', errors='replace'
            )
            for line in result.stdout.splitlines():
                if line.startswith('Name=') and line[5:].strip():
                    _cpu_name_cache = line[5:].strip()
                    return _cpu_name_cache
    except Exception:
        pass
    _cpu_name_cache = platform.processor() or 'Unknown CPU'
    return _cpu_name_cache


def get_os_version() -> str:
    global _os_info_cache
    if _os_info_cache:
        return _os_info_cache
    try:
        if platform.system() == 'Windows':
            result = subprocess.run(
                ['wmic', 'os', 'get', 'Caption', '/format:list'],
                capture_output=True, text=True, timeout=3,
                encoding='oem', errors='replace'
            )
            for line in result.stdout.splitlines():
                if line.startswith('Caption=') and line[8:].strip():
                    _os_info_cache = line[8:].strip()
                    return _os_info_cache
    except Exception:
        pass
    _os_info_cache = f"{platform.system()} {platform.release()}"
    return _os_info_cache


def get_motherboard() -> str:
    global _motherboard_cache
    if _motherboard_cache is not None:
        return _motherboard_cache
    try:
        if platform.system() == 'Windows':
            result = subprocess.run(
                ['wmic', 'baseboard', 'get', 'Manufacturer,Product', '/format:list'],
                capture_output=True, text=True, timeout=3,
                encoding='oem', errors='replace'
            )
            mfr, product = '', ''
            for line in result.stdout.splitlines():
                line = line.strip()
                if line.startswith('Manufacturer='):
                    mfr = line[13:].strip()
                elif line.startswith('Product='):
                    product = line[8:].strip()
            combined = f"{mfr} {product}".strip()
            if combined:
                _motherboard_cache = combined
                return _motherboard_cache
    except Exception:
        pass
    _motherboard_cache = 'N/A'
    return _motherboard_cache


# Имена датчиков различаются по вендорам: Intel зовёт пакет «CPU Package»,
# AMD Zen — «Core (Tctl/Tdie)», а среднее по кристаллам — «CCDs Average (Tdie)».
_CPU_TEMP_NAMES = (
    'CPU Package',          # Intel
    'Core (Tctl/Tdie)',     # AMD Zen
    'Core (Tdie)',
    'Core (Tctl)',
    'Core Average',         # Intel
    'CCDs Average (Tdie)',  # AMD
    'Core Max',
    'CCDs Max (Tdie)',
)

_CPU_MAX_TEMP_NAMES = ('Core Max', 'CCDs Max (Tdie)', 'CCD1 (Tdie)')

_CPU_POWER_NAMES = ('CPU Package', 'Package')


def get_cpu_temp() -> float | None:
    # 1. LibreHardwareMonitor — самый точный источник на Windows
    for name in _CPU_TEMP_NAMES:
        t = _lhm_exact('Temperature', name)
        if t is not None:
            return t

    # 2. ACPI thermal zones (often wrong on desktops)
    w = _ensure_wmi_acpi()
    if w is not None:
        try:
            zones = w.MSAcpi_ThermalZoneTemperature()
            if zones:
                return round((zones[0].CurrentTemperature / 10) - 273.15, 1)
        except Exception:
            pass

    # 3. psutil (Linux / macOS only)
    try:
        temps = psutil.sensors_temperatures()
        if temps:
            for name, entries in temps.items():
                nl = name.lower()
                for entry in entries:
                    if any(k in nl for k in ('core', 'cpu', 'package', 'k10temp', 'coretemp')):
                        if entry.current > 0:
                            return round(entry.current, 1)
    except Exception:
        pass
    return None


def get_cpu_max_core_temp() -> float | None:
    """Самое горячее ядро — отдельный показатель в макетах."""
    for name in _CPU_MAX_TEMP_NAMES:
        t = _lhm_exact('Temperature', name)
        if t is not None:
            return t

    # Запасной путь: максимум по датчикам отдельных ядер и кристаллов.
    # «Distance to TjMax» — не температура, его исключаем.
    values = []
    for s in _lhm_sensors:
        if s.SensorType != 'Temperature' or 'cpu' not in s.Identifier.lower():
            continue
        name = s.Name.lower()
        if 'distance' in name:
            continue
        if 'core' not in name and 'ccd' not in name:
            continue
        v = _num(s.Value)
        if v is not None:
            values.append(v)
    return max(values) if values else None


def get_cpu_clock_lhm() -> float | None:
    """Средняя частота по ядрам, ГГц. psutil на Windows отдаёт базовую."""
    # У AMD есть готовое среднее, у Intel — только частоты отдельных ядер.
    for name in ('Cores (Average)', 'Core Average'):
        v = _lhm_exact('Clock', name)
        if v:
            return round(v / 1000, 2)

    values = []
    for s in _lhm_sensors:
        if s.SensorType != 'Clock' or 'cpu' not in s.Identifier.lower():
            continue
        name = s.Name.lower()
        # «Bus Speed» и «(Effective)» портят среднее
        if 'core' not in name or 'effective' in name:
            continue
        v = _num(s.Value)
        if v and v > 0:
            values.append(v)
    if not values:
        return None
    return round(sum(values) / len(values) / 1000, 2)


def get_cpu_power_lhm() -> float | None:
    # Идентификаторы вида /intelcpu/0/... и /amdcpu/0/... — слеша перед «cpu» нет
    for name in _CPU_POWER_NAMES:
        v = _lhm_exact('Power', name, 'cpu')
        if v is not None:
            return v
    return None


def get_gpu_hotspot() -> float | None:
    """Hot Spot видеокарты. NVML его не отдаёт — только NVAPI через LHM."""
    for s in _lhm_sensors:
        if s.SensorType != 'Temperature' or '/gpu' not in s.Identifier.lower():
            continue
        if 'hot spot' in s.Name.lower():
            return _num(s.Value)
    return None


def _gpu_sensors() -> list:
    """Датчики видеокарты любого вендора: /gpu-nvidia/, /gpu-amd/, /gpu-intel/."""
    return [s for s in _lhm_sensors if '/gpu' in s.Identifier.lower()]


def _gpu_pick(sensors: list, sensor_type: str, *names: str) -> float | None:
    """Первое совпадение по списку имён — вендоры называют датчики по-разному."""
    for name in names:
        lname = name.lower()
        for s in sensors:
            if s.SensorType == sensor_type and s.Name.lower() == lname:
                v = _num(s.Value)
                if v is not None:
                    return v
    return None


def get_gpu_from_lhm() -> dict | None:
    """Видеокарта по данным LHM — путь для Radeon и Intel Arc, где нет NVML."""
    sensors = _gpu_sensors()
    if not sensors:
        return None

    name = next((getattr(s, 'Hardware', '') for s in sensors if getattr(s, 'Hardware', '')), 'GPU')

    load = _gpu_pick(sensors, 'Load', 'GPU Core', 'D3D 3D')
    if load is None:
        return None

    temp = _gpu_pick(sensors, 'Temperature', 'GPU Core')
    core_mhz = _gpu_pick(sensors, 'Clock', 'GPU Core')
    mem_mhz = _gpu_pick(sensors, 'Clock', 'GPU Memory')
    fan_pct = _gpu_pick(sensors, 'Control', 'GPU Fan', 'GPU Fan 1')
    power_w = _gpu_pick(sensors, 'Power', 'GPU Package', 'GPU Power', 'GPU PPT')
    bus_pct = _gpu_pick(sensors, 'Load', 'GPU Memory Controller', 'GPU Memory')

    # Объём видеопамяти LHM отдаёт в мегабайтах
    used_mb = _gpu_pick(sensors, 'SmallData', 'GPU Memory Used', 'D3D Dedicated Memory Used')
    total_mb = _gpu_pick(sensors, 'SmallData', 'GPU Memory Total', 'D3D Dedicated Memory Total')

    engines = {
        'd3d': int(load),
        'encode': _int_or_none(_gpu_pick(sensors, 'Load', 'D3D Video Encode')),
        'decode': _int_or_none(_gpu_pick(sensors, 'Load', 'D3D Video Decode')),
        'copy': _int_or_none(_gpu_pick(sensors, 'Load', 'D3D Copy')),
    }

    gpu_history.append(round(load, 1))

    return {
        'name': name,
        'utilization': round(load, 1),
        'clock_mhz': _int_or_none(core_mhz) or 0,
        'mem_clock_mhz': _int_or_none(mem_mhz) or 0,
        'clock_ghz': round(core_mhz / 1000, 2) if core_mhz else 0,
        'vram_used_gb': round(used_mb / 1024, 1) if used_mb else 0,
        'vram_total_gb': round(total_mb / 1024, 1) if total_mb else 0,
        'temp_c': _int_or_none(temp) or 0,
        'hotspot_c': get_gpu_hotspot(),
        'bus_pct': _int_or_none(bus_pct),
        'power_w': power_w or 0,
        'fan_pct': _int_or_none(fan_pct),
        'engines': engines,
        'history': list(gpu_history),
    }


def _int_or_none(value) -> int | None:
    return None if value is None else int(round(value))


# Идентификаторы накопителей у LHM: /nvme/3/..., /ahci/1/..., /hdd/0/...
_STORAGE_IDENT = re.compile(r'^/(nvme|ahci|hdd|storage)/(\d+)/')


def _num(value) -> float | None:
    try:
        return round(float(value), 1)
    except Exception:
        return None


def get_storage_lhm() -> dict:
    """{модель накопителя: {temp_c, life_pct, power_on_hours, ...}}

    Ключ — модель: LHM называет железо ровно так же, как Win32_DiskDrive.Model,
    поэтому запись надёжно сходится с буквой тома.
    """
    result: dict = {}
    for s in _lhm_sensors:
        ident = s.Identifier.lower()
        if not _STORAGE_IDENT.match(ident):
            continue

        model = getattr(s, 'Hardware', '') or ident
        entry = result.setdefault(model, {})
        name = s.Name.lower()

        if s.SensorType == 'Temperature' and name == 'temperature':
            entry['temp_c'] = _num(s.Value)
        elif s.SensorType == 'Level' and name == 'life':
            entry['life_pct'] = _num(s.Value)
        elif s.SensorType == 'Factor' and name == 'power on hours':
            entry['power_on_hours'] = _num(s.Value)
        elif s.SensorType == 'Data' and name == 'data read':
            entry['data_read_gb'] = _num(s.Value)
        elif s.SensorType == 'Data' and name == 'data written':
            entry['data_written_gb'] = _num(s.Value)

    return result


def _query_disk_map() -> dict:
    """{'C': {'model': 'Samsung SSD 990 PRO', 'index': 0}} — модель и номер
    физического диска для каждой буквы тома. Пусто, если WMI недоступен."""
    mapping: dict = {}
    if platform.system() != 'Windows':
        return mapping
    try:
        import wmi as _wmilib
        c = _wmilib.WMI()
        for drive in c.Win32_DiskDrive():
            model = (drive.Model or '').strip()
            try:
                index = int(drive.Index)
            except Exception:
                index = None
            for part in drive.associators('Win32_DiskDriveToDiskPartition'):
                for logical in part.associators('Win32_LogicalDiskToPartition'):
                    letter = (logical.DeviceID or '').rstrip(':').upper()
                    if letter:
                        mapping[letter] = {'model': model, 'index': index}
    except Exception:
        pass
    return mapping


def get_disk_map() -> dict:
    global _disk_map_cache
    if _disk_map_cache is None:
        _disk_map_cache = _query_disk_map()
    return _disk_map_cache


def get_ram_temp_lhm() -> float | None:
    """Самая горячая плашка. Пределы («Thermal Sensor High Limit») пропускаем."""
    values = []
    for s in _lhm_sensors:
        if s.SensorType != 'Temperature':
            continue
        ident = s.Identifier.lower()
        if '/memory/dimm/' not in ident and '/ram/' not in ident:
            continue
        if not s.Name.lower().startswith('dimm'):
            continue
        v = _num(s.Value)
        if v is not None:
            values.append(v)
    return max(values) if values else None


def _query_ram_hardware() -> tuple:
    speed_mhz, slots_used, slots_total = 0, 0, 2
    try:
        if platform.system() == 'Windows':
            result = subprocess.run(
                ['wmic', 'memorychip', 'get', 'Speed,BankLabel', '/format:list'],
                capture_output=True, text=True, timeout=5,
                encoding='oem', errors='replace'
            )
            speeds = []
            for line in result.stdout.splitlines():
                line = line.strip()
                if line.startswith('Speed='):
                    val = line[6:].strip()
                    if val.isdigit() and int(val) > 0:
                        speeds.append(int(val))
            if speeds:
                speed_mhz = speeds[0]
                slots_used = len(speeds)
    except Exception:
        pass
    return speed_mhz, slots_used, slots_total


def get_ram_info() -> dict:
    global _ram_hw_cache
    if _ram_hw_cache is None:
        speed_mhz, slots_used, slots_total = _query_ram_hardware()
        _ram_hw_cache = {'speed_mhz': speed_mhz, 'slots_used': slots_used, 'slots_total': slots_total}

    mem = psutil.virtual_memory()

    swap_used, swap_total = None, None
    try:
        swap = psutil.swap_memory()
        swap_used = round(swap.used / (1024 ** 3), 1)
        swap_total = round(swap.total / (1024 ** 3), 1)
    except Exception:
        pass

    return {
        'utilization_pct': round(mem.percent, 1),
        'used_gb': round(mem.used / (1024 ** 3), 1),
        'total_gb': round(mem.total / (1024 ** 3), 1),
        'speed_mhz': _ram_hw_cache['speed_mhz'],
        'slots_used': _ram_hw_cache['slots_used'],
        'slots_total': _ram_hw_cache['slots_total'],
        'committed_gb': round(mem.used / (1024 ** 3), 1),
        'swap_used_gb': swap_used,
        'swap_total_gb': swap_total,
        'temp_c': get_ram_temp_lhm(),
    }


def _elapsed(key: str) -> float:
    """Секунды с прошлого снятия счётчика `key`.

    Вызывается ровно там же, где обновляется соответствующий `_prev_*`,
    поэтому дельта счётчика и интервал всегда относятся к одному отрезку.
    """
    now = time.monotonic()
    prev = _rate_clock.get(key)
    _rate_clock[key] = now
    if prev is None:
        return POLL_INTERVAL
    return max(0.05, now - prev)


def get_perdisk_speeds() -> dict:
    """{индекс физического диска: (чтение МБ/с, запись МБ/с)}"""
    global _prev_perdisk_io
    speeds: dict = {}
    try:
        current = psutil.disk_io_counters(perdisk=True)
    except Exception:
        return speeds

    dt = _elapsed('perdisk')
    if _prev_perdisk_io:
        for key, cur in current.items():
            prev = _prev_perdisk_io.get(key)
            if prev is None:
                continue
            m = re.search(r'(\d+)$', key)
            if not m:
                continue
            idx = int(m.group(1))
            speeds[idx] = (
                max(0.0, (cur.read_bytes - prev.read_bytes) / 1024 / 1024 / dt),
                max(0.0, (cur.write_bytes - prev.write_bytes) / 1024 / 1024 / dt),
            )

    _prev_perdisk_io = current
    return speeds


def get_disk_info() -> list:
    global _prev_disk_io

    total_read_mbps = 0.0
    total_write_mbps = 0.0
    try:
        current_io = psutil.disk_io_counters()
        if current_io:
            dt = _elapsed('disk')
            if _prev_disk_io:
                total_read_mbps = max(0.0, (current_io.read_bytes - _prev_disk_io.read_bytes) / 1024 / 1024 / dt)
                total_write_mbps = max(0.0, (current_io.write_bytes - _prev_disk_io.write_bytes) / 1024 / 1024 / dt)
            _prev_disk_io = current_io
    except Exception:
        pass

    perdisk = get_perdisk_speeds()

    storage = get_storage_lhm()
    disk_map = get_disk_map()

    disks = []
    try:
        global _partitions_cache
        if time.time() - _partitions_cache[0] > _PARTITIONS_REFRESH:
            _partitions_cache = (time.time(), psutil.disk_partitions(all=False))
        partitions = _partitions_cache[1]
        first = True
        for partition in partitions:
            dev = partition.device.replace('\\', '').replace('/', '')
            drive_letter = dev[:2] if len(dev) >= 2 else dev
            letter = drive_letter.rstrip(':').upper()

            info = disk_map.get(letter) or {}
            model = info.get('model') or partition.device
            phys_idx = info.get('index')
            kind = _drive_kind_by_index(phys_idx) if phys_idx is not None else None
            asleep = bool(phys_idx is not None and _hdd_asleep.get(phys_idx))

            usage = _disk_usage(partition.mountpoint, phys_idx, asleep)
            if usage is None:
                continue
            label = f"{drive_letter} {model}".strip() if info.get('model') else f"Диск ({drive_letter})"

            # Обычно имя железа в LHM совпадает с Win32_DiskDrive.Model.
            # Если написание разошлось — ищем по вхождению, затем по номеру диска.
            sm = storage.get(model)
            if sm is None:
                sm = _match_storage(storage, model, phys_idx)

            io = perdisk.get(phys_idx) if phys_idx is not None else None
            if io is None:
                # без привязки к физическому диску показываем общий поток на первом
                io = (total_read_mbps, total_write_mbps) if first else (0.0, 0.0)

            life = sm.get('life_pct')
            disks.append({
                'label': label,
                'model': model,
                'used_gb': round(usage.used / (1024 ** 3), 1),
                'free_gb': round(usage.free / (1024 ** 3), 1),
                'total_gb': round(usage.total / (1024 ** 3), 1),
                'utilization_pct': round(usage.percent, 1),
                'read_speed_mbps': round(io[0], 1),
                'write_speed_mbps': round(io[1], 1),
                # Остановленный диск не опрашивается: старая температура была бы неправдой
                'temp_c': None if asleep else sm.get('temp_c'),
                'kind': kind,
                'asleep': asleep,
                'life_pct': life,
                'power_on_hours': sm.get('power_on_hours'),
                'health': _disk_health(life),
            })
            first = False
    except Exception:
        pass

    return disks


def _disk_usage(mount: str, phys_idx, asleep: bool):
    """Свободное место тома. Пока на диск ничего не записали, оно не меняется,
    поэтому запрос повторяется только после записи или раз в полчаса."""
    now = time.time()
    cached = _usage_cache.get(mount)
    written = None
    if phys_idx is not None and _prev_perdisk_io:
        cur = _prev_perdisk_io.get(f'PhysicalDrive{phys_idx}')
        written = cur.write_bytes if cur else None

    if cached is not None:
        usage, at, written_at = cached
        if asleep:
            return usage
        fresh = now - at < (_FREE_REFRESH if phys_idx is not None else _PARTITIONS_REFRESH)
        if fresh and written == written_at:
            return usage

    try:
        usage = psutil.disk_usage(mount)
    except Exception:
        return cached[0] if cached else None
    _usage_cache[mount] = (usage, now, written)
    return usage


def _match_storage(storage: dict, model: str, phys_idx: int | None) -> dict:
    """Запасное сопоставление накопителя с записью LHM."""
    target = (model or '').strip().lower()
    if target:
        for key, entry in storage.items():
            k = key.strip().lower()
            if k and (k in target or target in k):
                return entry

    # Последний шанс — порядок перечисления: LHM нумерует диски так же,
    # как Win32_DiskDrive.Index на большинстве конфигураций.
    if phys_idx is not None:
        keys = list(storage)
        if 0 <= phys_idx < len(keys):
            return storage[keys[phys_idx]]

    return {}


def _disk_health(life_pct: float | None) -> str:
    """Остаток ресурса SSD → словесная оценка. Для HDD показателя нет."""
    if life_pct is None:
        return '—'
    if life_pct >= 50:
        return 'Хорошо'
    if life_pct >= 20:
        return 'Износ'
    return 'Замена'


def get_default_route() -> tuple:
    """(локальный IP, IP шлюза) активного маршрута наружу.

    UDP-сокет никуда не отправляет данных — ядро лишь выбирает исходящий
    интерфейс, поэтому виртуальные адаптеры (WSL, Hyper-V) не мешают.
    """
    global _route_cache, _route_last_check
    now = time.time()
    if _route_cache is not None and now - _route_last_check < _ROUTE_INTERVAL:
        return _route_cache

    _route_last_check = now
    ip = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(('8.8.8.8', 53))
            ip = s.getsockname()[0]
        finally:
            s.close()
    except Exception:
        pass

    gateway = None
    if platform.system() == 'Windows':
        try:
            out = subprocess.run(
                ['route', 'print', '-4', '0.0.0.0'],
                capture_output=True, text=True, timeout=3,
                encoding='oem', errors='replace'
            ).stdout
            for line in out.splitlines():
                parts = line.split()
                if len(parts) >= 5 and parts[0] == '0.0.0.0' and parts[1] == '0.0.0.0':
                    if ip is None or parts[3] == ip:
                        gateway = parts[2]
                        break
        except Exception:
            pass

    _route_cache = (ip, gateway)
    return _route_cache


def get_active_nic(ip: str | None) -> tuple:
    """(имя интерфейса, тип) — интерфейс, которому принадлежит локальный IP."""
    if not ip:
        return None, 'Ethernet'
    try:
        for name, addrs in psutil.net_if_addrs().items():
            for addr in addrs:
                if addr.family == socket.AF_INET and addr.address == ip:
                    lower = name.lower()
                    wireless = any(k in lower for k in ('wi-fi', 'wifi', 'wlan', 'wireless', 'беспровод'))
                    return name, ('Wi-Fi' if wireless else 'Ethernet')
    except Exception:
        pass
    return None, 'Ethernet'


def get_latency() -> int:
    """Пинг до шлюза — характеризует канал, а не путь до чужого DNS."""
    global _latency_cache, _latency_last_check
    now = time.time()
    if now - _latency_last_check < _LATENCY_INTERVAL:
        return _latency_cache
    _latency_last_check = now

    _, gateway = get_default_route()
    target = gateway or '8.8.8.8'
    try:
        start = time.perf_counter()
        if gateway:
            out = subprocess.run(
                ['ping', '-n', '1', '-w', '1000', gateway],
                capture_output=True, text=True, timeout=3,
                encoding='oem', errors='replace'
            ).stdout
            m = re.search(r'[=<]\s*(\d+)\s*(?:ms|мс)', out)
            _latency_cache = int(m.group(1)) if m else 0
        else:
            s = socket.create_connection((target, 53), timeout=1.0)
            s.close()
            _latency_cache = max(1, int((time.perf_counter() - start) * 1000))
    except Exception:
        _latency_cache = 0
    return _latency_cache


def get_network_info() -> dict:
    global _prev_net_io

    ip, _gateway = get_default_route()
    nic, net_type = get_active_nic(ip)

    down_bytes_ps = 0.0
    up_bytes_ps = 0.0
    try:
        # Считаем только по активному интерфейсу, иначе виртуальные адаптеры
        # и петля удваивают трафик.
        if nic:
            counters = psutil.net_io_counters(pernic=True).get(nic)
        else:
            counters = psutil.net_io_counters()
        if counters is not None:
            dt = _elapsed('net')
            if _prev_net_io is not None:
                delta_recv = counters.bytes_recv - _prev_net_io.bytes_recv
                delta_sent = counters.bytes_sent - _prev_net_io.bytes_sent
                # счётчик мог обнулиться при смене интерфейса
                if delta_recv >= 0 and delta_sent >= 0:
                    down_bytes_ps = max(0.0, delta_recv / dt)
                    up_bytes_ps = max(0.0, delta_sent / dt)
            _prev_net_io = counters
    except Exception:
        pass

    # Мегабиты — десятичные, как их считают провайдеры и диспетчер задач.
    download_mbps = down_bytes_ps * 8 / 1_000_000
    upload_mbps = up_bytes_ps * 8 / 1_000_000

    is_up = False
    try:
        stats = psutil.net_if_stats()
        is_up = stats[nic].isup if nic and nic in stats else any(s.isup for s in stats.values())
    except Exception:
        pass

    link_mbps = 0
    try:
        stats = psutil.net_if_stats()
        if nic and nic in stats:
            link_mbps = max(0, stats[nic].speed)
    except Exception:
        pass

    return {
        'status': 'Connected' if is_up else 'Disconnected',
        'type': net_type,
        'interface': nic or '—',
        'link_mbps': link_mbps,
        'download_mbps': round(download_mbps, 2),
        'upload_mbps': round(upload_mbps, 2),
        # Байты в секунду — из них UI сам выбирает КБ/с или МБ/с.
        'download_bytes_ps': round(down_bytes_ps, 1),
        'upload_bytes_ps': round(up_bytes_ps, 1),
        'latency_ms': get_latency(),
        'ip': ip or '—',
        'signal': 'Good',
    }


def get_power_info() -> dict:
    try:
        battery = psutil.sensors_battery()
        if battery:
            pct = round(battery.percent, 1)
            plugged = battery.power_plugged
            secleft = battery.secsleft

            if plugged:
                estimated = 'N/A'
            elif secleft and secleft > 0 and secleft not in (
                psutil.POWER_TIME_UNKNOWN, psutil.POWER_TIME_UNLIMITED
            ):
                h = secleft // 3600
                m = (secleft % 3600) // 60
                estimated = f"{h}h {m}m"
            else:
                estimated = 'Calculating...'

            return {
                'status': 'AC Connected' if plugged else 'On Battery',
                'charging': bool(plugged),
                'battery_pct': pct,
                'power_plan': 'Balanced',
                'estimated_time': estimated,
                'voltage_v': 0,
                'current_a': 0,
                'power_w': 0,
            }
    except Exception:
        pass

    return {
        'status': 'AC Connected',
        'charging': True,
        'battery_pct': 100,
        'power_plan': 'Balanced',
        'estimated_time': 'N/A',
        'voltage_v': 0,
        'current_a': 0,
        'power_w': 0,
    }


def get_gpu_info() -> dict:
    if NVML_AVAILABLE and _nvml_handle is not None:
        try:
            util = pynvml.nvmlDeviceGetUtilizationRates(_nvml_handle)
            mem = pynvml.nvmlDeviceGetMemoryInfo(_nvml_handle)
            clock_mhz = pynvml.nvmlDeviceGetClockInfo(_nvml_handle, pynvml.NVML_CLOCK_GRAPHICS)
            mem_clock_mhz = pynvml.nvmlDeviceGetClockInfo(_nvml_handle, pynvml.NVML_CLOCK_MEM)
            temp = pynvml.nvmlDeviceGetTemperature(_nvml_handle, pynvml.NVML_TEMPERATURE_GPU)

            try:
                power_w = round(pynvml.nvmlDeviceGetPowerUsage(_nvml_handle) / 1000, 1)
            except Exception:
                power_w = 0

            try:
                # 0 % — валидное значение: в простое вентиляторы стоят.
                # Отсутствие датчика отличаем как None.
                fan_pct = int(pynvml.nvmlDeviceGetFanSpeed(_nvml_handle))
            except Exception:
                fan_pct = None

            name = pynvml.nvmlDeviceGetName(_nvml_handle)
            if isinstance(name, bytes):
                name = name.decode('utf-8')

            try:
                encode_pct = pynvml.nvmlDeviceGetEncoderUtilization(_nvml_handle)[0]
            except Exception:
                encode_pct = None

            try:
                decode_pct = pynvml.nvmlDeviceGetDecoderUtilization(_nvml_handle)[0]
            except Exception:
                decode_pct = None

            gpu_load = round(util.gpu, 1)
            gpu_history.append(gpu_load)

            return {
                'name': name,
                'utilization': gpu_load,
                'clock_mhz': clock_mhz,
                'mem_clock_mhz': mem_clock_mhz,
                'clock_ghz': round(clock_mhz / 1000, 2),
                'vram_used_gb': round(mem.used / (1024 ** 3), 1),
                'vram_total_gb': round(mem.total / (1024 ** 3), 1),
                'temp_c': temp,
                'hotspot_c': get_gpu_hotspot(),
                'bus_pct': int(util.memory),
                'power_w': power_w,
                'fan_pct': fan_pct,
                'engines': {
                    'd3d': int(util.gpu),
                    'encode': encode_pct,
                    'decode': decode_pct,
                    'copy': None,
                },
                'history': list(gpu_history),
            }
        except Exception:
            pass

    # Не NVIDIA (Radeon, Intel Arc) либо NVML недоступен — читаем через LHM
    from_lhm = get_gpu_from_lhm()
    if from_lhm is not None:
        return from_lhm

    gpu_history.append(0)
    return {
        'name': 'Видеокарта не найдена',
        'utilization': 0,
        'clock_mhz': 0,
        'mem_clock_mhz': 0,
        'clock_ghz': 0,
        'vram_used_gb': 0,
        'vram_total_gb': 0,
        'temp_c': 0,
        'hotspot_c': None,
        'bus_pct': None,
        'power_w': 0,
        'fan_pct': None,
        'engines': {'d3d': None, 'encode': None, 'decode': None, 'copy': None},
        'history': list(gpu_history),
    }


def get_fans_info() -> dict:
    cpu_rpm, gpu_rpm, cpu_pct, gpu_pct = 0, 0, 0, 0

    # LHM-based fan data (most reliable on Windows desktop)
    for s in _lhm_sensors:
        ident = s.Identifier.lower()
        name = s.Name.lower()
        try:
            val = int(float(s.Value))
        except Exception:
            continue
        if s.SensorType == 'Fan':
            if '/cpu/' in ident or 'cpu' in name:
                cpu_rpm = val
            elif '/gpu/' in ident or 'gpu' in name:
                gpu_rpm = val
        elif s.SensorType == 'Control' and 'fan' in name:
            if '/cpu/' in ident or 'cpu' in name:
                cpu_pct = min(100, val)
            elif '/gpu/' in ident or 'gpu' in name:
                gpu_pct = min(100, val)

    # GPU fan from NVML (reliable for NVIDIA cards)
    if NVML_AVAILABLE and _nvml_handle is not None:
        try:
            nvml_fan = pynvml.nvmlDeviceGetFanSpeed(_nvml_handle)
            if nvml_fan >= 0:
                gpu_pct = nvml_fan
                if gpu_rpm == 0 and nvml_fan > 0:
                    gpu_rpm = int(nvml_fan / 100 * 3000)
        except Exception:
            pass

    # psutil fans (Linux / some systems — no-op on Windows)
    if cpu_rpm == 0:
        try:
            fans = psutil.sensors_fans()
            if fans:
                all_rpms = [e.current for entries in fans.values() for e in entries]
                if all_rpms:
                    cpu_rpm = all_rpms[0]
                    cpu_pct = min(100, int(cpu_rpm / 5000 * 100))
                if len(all_rpms) > 1 and gpu_rpm == 0:
                    gpu_rpm = all_rpms[1]
                    gpu_pct = min(100, int(gpu_rpm / 5000 * 100))
        except Exception:
            pass

    return {'cpu_rpm': cpu_rpm, 'cpu_pct': cpu_pct, 'gpu_rpm': gpu_rpm, 'gpu_pct': gpu_pct}


def _fan_pct(key: str, rpm: int, control: float | None) -> int:
    """Процент оборотов: PWM из LHM, иначе доля от наблюдавшегося максимума."""
    if control is not None:
        return int(round(min(100.0, max(0.0, control))))
    peak = max(_fan_peak.get(key, 0), rpm, 1500)
    _fan_peak[key] = peak
    return int(round(rpm / peak * 100)) if peak else 0


# Осмысленные имена отдают не все платы: SuperIO обычно нумерует «Fan #N»,
# а через EC приходят «CPU Fan», «Chassis Fan 2», «Pump Fan» и т. п.
_FAN_WORDS = (
    ('pump', 'ПОМПА'),
    ('aio', 'ПОМПА'),
    ('cpu opt', 'ЦП ОПТ'),
    ('cpu', 'ЦП'),
    ('gpu', 'ГП'),
    ('chassis', 'КОРПУС'),
    ('system', 'КОРПУС'),
    ('chipset', 'ЧИПСЕТ'),
    ('vrm', 'VRM'),
    ('water', 'СЖО'),
)


def _fan_label(sensor) -> str:
    """«Fan #3» → «ВЕНТ 3», «Chassis Fan 2» → «КОРПУС 2», «GPU Fan» → «ГП»."""
    name = sensor.Name
    lower = name.lower()
    hw = str(getattr(sensor, 'HardwareType', '') or '').lower()

    m = re.search(r'#?\s*(\d+)\s*$', name)
    num = m.group(1) if m else ''

    for word, label in _FAN_WORDS:
        if word in lower:
            return f"{label} {num}".strip()

    if hw.startswith('gpu'):
        return f"ГП {num}".strip()
    if num:
        return f"ВЕНТ {num}"
    return name.upper()


def get_fans_list() -> list:
    """Все вентиляторы по отдельности — макеты показывают до пяти штук."""
    controls = {}
    for s in _lhm_sensors:
        if s.SensorType == 'Control':
            v = _num(s.Value)
            if v is not None:
                controls[s.Identifier.lower()] = v

    fans = []
    for s in _lhm_sensors:
        if s.SensorType != 'Fan':
            continue
        rpm_val = _num(s.Value)
        if rpm_val is None:
            continue
        rpm = int(rpm_val)
        # Разъём без подключённого вентилятора — не показываем.
        if rpm <= 0:
            continue
        ident = s.Identifier.lower()
        control = controls.get(ident.replace('/fan/', '/control/'))
        fans.append({'name': _fan_label(s), 'rpm': rpm, 'pct': _fan_pct(ident, rpm, control)})

    # Вентилятор видеокарты из NVML, если LHM его не отдал
    if NVML_AVAILABLE and _nvml_handle is not None and not any('ГП' in f['name'] for f in fans):
        try:
            nvml_fan = pynvml.nvmlDeviceGetFanSpeed(_nvml_handle)
            if nvml_fan is not None and nvml_fan > 0:
                fans.append({'name': 'ГП', 'rpm': 0, 'pct': int(nvml_fan)})
        except Exception:
            pass

    return fans


def get_uptime_str() -> str:
    try:
        secs = time.time() - psutil.boot_time()
        d = int(secs // 86400)
        h = int((secs % 86400) // 3600)
        m = int((secs % 3600) // 60)
        if d > 0:
            return f"{d} Д {h} Ч"
        elif h > 0:
            return f"{h} Ч {m:02d} М"
        return f"{m} М"
    except Exception:
        return '—'


def collect_metrics() -> dict:
    refresh_lhm_sensors()

    cpu_pct = psutil.cpu_percent(interval=None)
    cpu_freq = psutil.cpu_freq()
    cpu_history.append(cpu_pct)

    per_core_raw = psutil.cpu_percent(percpu=True, interval=None)
    per_core = [round(p, 0) for p in per_core_raw]

    total_read_tb = 0.0
    total_written_gb = 0.0
    try:
        disk_io = psutil.disk_io_counters()
        if disk_io:
            total_read_tb = round(disk_io.read_bytes / (1024 ** 4), 2)
            total_written_gb = round(disk_io.write_bytes / (1024 ** 3), 1)
    except Exception:
        pass

    # LHM отдаёт реальную частоту по ядрам; psutil на Windows — базовую.
    clock_ghz = get_cpu_clock_lhm()
    if clock_ghz is None:
        clock_ghz = round(cpu_freq.current / 1000, 2) if cpu_freq else 0

    disks = get_disk_info()
    lhm_status = _lhm_embedded.status() if _lhm_embedded is not None else {}
    live_sensors = sum(1 for s in _lhm_sensors if s.Value is not None)

    return {
        'cpu': {
            'name': get_cpu_name(),
            'utilization': round(cpu_pct, 1),
            'clock_ghz': clock_ghz,
            'threads': psutil.cpu_count(logical=True) or 0,
            'cores': psutil.cpu_count(logical=False),
            'temp_c': get_cpu_temp(),
            'max_core_temp_c': get_cpu_max_core_temp(),
            'power_w': get_cpu_power_lhm(),
            'history': list(cpu_history),
            'per_core': per_core,
        },
        'gpu': get_gpu_info(),
        'ram': get_ram_info(),
        'disks': disks,
        'network': get_network_info(),
        'power': get_power_info(),
        'fans': get_fans_info(),
        'fans_list': get_fans_list(),
        'system': {
            'os': get_os_version(),
            'hostname': platform.node().upper() or socket.gethostname().upper(),
            'motherboard': get_motherboard(),
            'uptime': get_uptime_str(),
            'sensor_count': live_sensors or None,
            'sensor_source': _lhm_source,
            'elevated': bool(lhm_status.get('elevated')),
            'poll_ms': int(POLL_INTERVAL * 1000),
            'last_updated': datetime.now().strftime('%I:%M:%S %p'),
        },
        'smart': _build_smart(disks),
        'summary': {
            'healthy': all(d['health'] in ('Хорошо', '—') for d in disks),
            'total_uptime': get_uptime_str(),
            'total_data_read_tb': total_read_tb,
            'total_data_written_gb': total_written_gb,
        },
    }


def _build_smart(disks: list) -> dict:
    """Сводка SMART по самому нагруженному накопителю."""
    temps = [d['temp_c'] for d in disks if d.get('temp_c') is not None]
    hours = [d['power_on_hours'] for d in disks if d.get('power_on_hours') is not None]
    lives = [d['life_pct'] for d in disks if d.get('life_pct') is not None]

    return {
        'overall': _disk_health(min(lives) if lives else None),
        'reallocated_sectors': 0,
        'power_on_hours': int(max(hours)) if hours else None,
        'life_pct': min(lives) if lives else None,
        'temp_c': max(temps) if temps else None,
        'drive_status': 'OK' if temps else '—',
    }


if __name__ == '__main__':
    psutil.cpu_percent(interval=None)
    psutil.cpu_percent(percpu=True, interval=None)
    _ensure_wmi_acpi()
    time.sleep(0.5)

    try:
        while True:
            try:
                data = collect_metrics()
                print(json.dumps(data), flush=True)
            except Exception as e:
                sys.stderr.write(f"Error: {e}\n")
                sys.stderr.flush()
            time.sleep(POLL_INTERVAL)
    except KeyboardInterrupt:
        pass
    finally:
        if _lhm_embedded is not None:
            _lhm_embedded.close()
