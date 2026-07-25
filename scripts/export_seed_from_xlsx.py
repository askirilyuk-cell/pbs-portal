# -*- coding: utf-8 -*-
"""
Генерация seed-данных портала из «Ф.1–П Справочники производства.xlsx».
Выгружает три справочника в nocodb/seed/data/*.json — это источник истины для seed.mjs.

Запуск:  python scripts/export_seed_from_xlsx.py
"""
import openpyxl, json, io, os, warnings

warnings.simplefilter("ignore")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "docs", "Ф.1–П Справочники производства.xlsx")
OUT = os.path.join(ROOT, "nocodb", "seed", "data")
os.makedirs(OUT, exist_ok=True)


def rows(ws):
    out = []
    for r in ws.iter_rows(values_only=True):
        out.append(["" if c is None else str(c).strip() for c in r])
    return out


def write(name, data):
    with io.open(os.path.join(OUT, name), "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    print(f"  {name}: {len(data)} записей")


wb = openpyxl.load_workbook(SRC, data_only=True)

# --- Участки -------------------------------------------------------------
ws = wb["Перечень участков"]
r = rows(ws)
# header at index 2: Код | Участок | Описание | Оборудование | Тип | Ответственный | Должность | Примечание
uchastki = []
for row in r[3:]:
    if not row[0].startswith("УЧ"):
        continue
    uchastki.append({
        "code": row[0],
        "name": row[1],
        "description": row[2],
        "equipment": row[3],
        "kind": row[4],          # Основной / Вспомогательный
        "responsible": row[5],
        "position": row[6],
    })
write("uchastki.json", uchastki)

# --- Типы операций -------------------------------------------------------
ws = wb["Типы операций"]
r = rows(ws)
# header: Код типа | Наименование | Участок (код УЧ) | РИ
op_types = []
for row in r[1:]:
    if not row[0].startswith("ОП"):
        continue
    op_types.append({
        "code": row[0],
        "name": row[1],
        "section_code": row[2] if row[2] != "—" else "",
        "ri": row[3] if row[3] != "—" else "",
    })
write("op_types.json", op_types)

# --- Параметры типов -----------------------------------------------------
ws = wb["Параметры типов"]
r = rows(ws)
# header: Тип операции (код) | Параметр | Единица | Тип значения | Обязательность
VALTYPE = {
    "число": "Decimal",
    "целое": "Number",
    "текст": "SingleLineText",
    "список": "SingleSelect",
}
op_params = []
for row in r[1:]:
    if not row[0].startswith("ОП"):
        continue
    if row[1].startswith("Параметры контроля"):
        continue  # ОП-ОТК — параметры по точкам контроля, не фиксированный набор
    raw_vt = row[3]
    unit = row[2] if row[2] != "—" else ""
    op_params.append({
        "op_type_code": row[0],
        "param": row[1],
        "unit": unit,
        "value_type": VALTYPE.get(raw_vt, "SingleLineText"),
        # для «список» варианты лежат в колонке «Единица»
        "options": [o.strip() for o in unit.split(",")] if raw_vt == "список" else [],
        "required": row[4] == "да",
    })
write("op_params.json", op_params)

print("Готово.")
