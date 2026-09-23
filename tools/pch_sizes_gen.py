#!/usr/bin/env python3
"""K-288: справочник типоразмеров ПЧ для конструктора позиций ПЗ.

Источник — перечень наименований и артикулов ПЧ (досье ПЧ-Д-002, xlsx Соловьёва от 12.08.2026),
лист «Наименования и артикулы». Результат — portal/pch-sizes.json, который отдаёт
GET /api/dict/pch-sizes. Наименование и артикул собираются по правилам Приложения Б
к РИ.1–Д.1.2 ред. 1.1 (а не копируются из xlsx — там разнобой в пунктуации).

  python3 tools/pch_sizes_gen.py [xlsx] [out.json]
"""
import json, re, sys, datetime
import openpyxl

SRC = sys.argv[1] if len(sys.argv) > 1 else 'tools/pch-perechen-2026-08-12.xlsx'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'portal/pch-sizes.json'

TYPES = [  # код → признаки (порядок = порядок в конструкторе; ПЧ00 базовый)
    ('ПЧ00', 'армированный', 'с уплотнительным кольцом', True, True),
    ('ПЧ01', 'армированный', 'без уплотнительного кольца', True, False),
    ('ПЧ02', 'неармированный', 'с уплотнительным кольцом', False, True),
    ('ПЧ03', 'неармированный', 'без уплотнительного кольца', False, False),
]
MATERIALS = [('00', 'NBR75'), ('01', 'NBR85'), ('02', 'HNBR80')]

def num(s):
    """'168,3' | 168.3 → '168.3' (строка с точкой, без лишних нулей, но 9.50 → '9.50' как в перечне)."""
    if isinstance(s, (int, float)):
        s = repr(float(s))
        return s[:-2] if s.endswith('.0') else s
    return str(s).strip().replace(',', '.')

def ru(s):
    return s.replace('.', ',')

wb = openpyxl.load_workbook(SRC, data_only=True)
ws = wb['Наименования и артикулы']
sizes = {}   # (proj, dia, wall) → dict
order = []
for r in ws.iter_rows(min_row=5, values_only=True):
    proj = r[1]
    if not proj or not str(proj).startswith('ПЧ'):
        continue
    dia = num(r[2])
    wmin, wmax = [num(x) for x in re.split(r'\s*[–—-]\s*', str(r[3]).strip())]
    typ = str(r[4])[:4]; mat = str(r[5])[:2]
    key = (proj, dia, wmin, wmax)
    if key not in sizes:
        sizes[key] = {'proj': proj, 'dia': dia, 'wallMin': wmin, 'wallMax': wmax,
                      'dims': {k: r[i] for k, i in zip('АБВГД', range(9, 14)) if r[i] not in (None, '')},
                      'variants': []}
        order.append(key)
    mass = r[15]
    sizes[key]['variants'].append({
        'type': typ, 'mat': mat,
        'drawing': str(r[8] or '').strip(),                  # обозначение КД из перечня (может не быть файла)
        'mass': round(float(mass), 3) if isinstance(mass, (int, float)) else None,
    })

out_sizes = []
for key in order:
    s = sizes[key]
    art_base = f"{s['dia']}-{s['wallMin']}-{s['wallMax']}"
    variants = []
    for tcode, arm, ring, _, _ in TYPES:
        for mcode, mname in MATERIALS:
            v = next((x for x in s['variants'] if x['type'] == tcode and x['mat'] == mcode), None)
            if not v:
                continue
            art = f"{art_base}-{tcode}-{mcode}"
            name = (f"Пакер чашечного типа, {arm}, {ring} для обсадной колонны Ø{ru(s['dia'])} мм, "
                    f"т.с. {ru(s['wallMin'])} – {ru(s['wallMax'])} мм {mname}")
            variants.append({'type': tcode, 'mat': mcode, 'art': art, 'name': name,
                             'drawing': v['drawing'].replace('ПБС.', ''), 'mass': v['mass']})
    out_sizes.append({'proj': s['proj'], 'dia': s['dia'], 'wallMin': s['wallMin'], 'wallMax': s['wallMax'],
                      'dims': s['dims'], 'variants': variants})

# сортировка по диаметру, затем по стенке
out_sizes.sort(key=lambda s: (float(s['dia']), float(s['wallMin'])))

doc = {
    'group': 'ПЧ', 'name': 'Пакер чашечного типа',
    'source': 'Перечень наименований и артикулов ПЧ (ТПП), досье ПЧ-Д-002, 12.08.2026; правила — Приложение Б к РИ.1–Д.1.2 ред. 1.1',
    'generated': datetime.date.today().isoformat(),
    'types': [{'code': c, 'arm': a, 'ring': r, 'label': f"{c} — {a}, {r}"} for c, a, r, _, _ in TYPES],
    'materials': [{'code': c, 'name': n, 'label': f"{c} — {n}" + (' (базовый)' if c == '00' else '')} for c, n in MATERIALS],
    'sizes': out_sizes,
}
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(doc, f, ensure_ascii=False, indent=1)
print(f"{OUT}: типоразмеров {len(out_sizes)}, вариантов {sum(len(s['variants']) for s in out_sizes)}")
for s in out_sizes:
    print(f"  {s['proj']} Ø{s['dia']} {s['wallMin']}–{s['wallMax']} · {len(s['variants'])} вар. · {s['variants'][0]['drawing']}")
