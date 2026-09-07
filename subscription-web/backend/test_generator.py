import io
import random
from datetime import date, timedelta

SERVICES = [
    (599.0, 5, "NETFLIX.COM 866-579-7172 US"),
    (599.0, 5, "NFLX* 8NQ4R2"),
    (599.0, 5, "Netflix"),
    (399.0, 7, "YNDX_PLUS"),
    (399.0, 7, "YNDX.MUSIC"),
    (399.0, 7, "YANDEX_PLUS"),
    (399.0, 7, "Yandex Plus"),
    (299.0, 12, "IVI.RU"),
    (299.0, 12, "IVI* 8NQ4R2"),
    (299.0, 12, "Ivi"),
    (449.0, 3, "OKKO.SUBSCRIPTION"),
    (449.0, 3, "Okko"),
    (449.0, 3, "OKKO.TV"),
    (169.0, 1, "TG_PREMIUM"),
    (169.0, 1, "Telegram Premium"),
    (169.0, 1, "PremiumBot"),
    (299.0, 10, "VK.COM"),
    (299.0, 10, "SUBSCRIPTION VK"),
    (299.0, 10, "VK Music"),
    (249.0, 15, "KION.RU"),
    (249.0, 15, "KION"),
    (249.0, 15, "KION Subscription"),
    (399.0, 5, "KINOPOISK HD"),
    (399.0, 5, "Kinopoisk"),
    (399.0, 5, "KP*HD"),
    (269.0, 24, "SPOTIFY AB"),
    (269.0, 24, "SPOT* MUSIC"),
    (269.0, 24, "Spotify"),
    (149.0, 28, "ICLOUD+ 50GB"),
    (149.0, 28, "APPLE.COM/BILL"),
    (3490.0, 1, "WORLD CLASS"),
    (3490.0, 1, "WORLDCLASS"),
    (3490.0, 1, "WORLD CLASS FITNES"),
]

NOISE = [
    ("PYATEROCHKA 2451", lambda r: round(random.uniform(150, 1500), 2)),
    ("MAGAZIN MAGNIT", lambda r: round(random.uniform(200, 3000), 2)),
    ("STARBUCKS COFFEE", lambda r: round(random.uniform(150, 800), 2)),
    ("YANDEX TAXI", lambda r: round(random.uniform(150, 1200), 2)),
    ("APTEKA 36.6", lambda r: round(random.uniform(100, 1500), 2)),
    ("MCDONALDS", lambda r: round(random.uniform(200, 900), 2)),
    ("KFC", lambda r: round(random.uniform(250, 1000), 2)),
    ("AZS LUKOIL", lambda r: round(random.uniform(800, 3000), 2)),
    ("CINEMA PARK", lambda r: round(random.uniform(400, 1800), 2)),
    ("OZON WILDBERRIES", lambda r: round(random.uniform(500, 5000), 2)),
]


def _random_day(d):
    return d - timedelta(days=random.randint(0, 120))


def _add_months(d, months):
    m = d.month - 1 + months
    return date(d.year + m // 12, m - 12 * (m // 12) + 1, min(d.day, 28))


def generate_test_csv():
    rng = random.Random()
    today = date.today()
    rows = []

    # Подписки из SERVICES: лёгкий jitter суммы + редкие пропуски месяца.
    # Сервис-триплет (одинаковая сумма и день) даёт ОДНО списание в месяц
    # с ротацией написаний — как в реальной выписке: у сервиса много вариантов
    # названия мерчанта, но списание раз в месяц, а не три.
    from collections import defaultdict
    service_groups = defaultdict(list)
    for base_amount, day_n, name in SERVICES:
        service_groups[(base_amount, day_n)].append(name)

    for (base_amount, day_n), names in service_groups.items():
        names = sorted(names)
        for i in range(6, -1, -1):
            d = _add_months(today.replace(day=min(day_n, 28)), -i)
            d = d + timedelta(days=rng.randint(-2, 2))
            if (d - today).days > 0:
                d = d - timedelta(days=rng.randint(25, 31))
            # ~12% месяцев пропускаем списание (сервис «выпал» на месяц)
            if rng.random() < 0.12:
                continue
            # написание мерчанта ротируется от месяца к месяцу
            name = names[i % len(names)]
            # jitter: -10% .. +10% от базовой суммы
            jitter = base_amount * rng.uniform(0.9, 1.1)
            rows.append((d, name, -round(abs(jitter), 2), "Subscription"))

    # Шум
    for i in range(6):
        m_start = _add_months(today.replace(day=1), -i)
        for _ in range(rng.randint(3, 5)):
            d = m_start + timedelta(days=rng.randint(0, 27))
            if (d - today).days > 0:
                d = d - timedelta(days=28)
            desc, fn = rng.choice(NOISE)
            rows.append((d, desc, -abs(fn(rng)), "Other"))

    rows.sort(key=lambda x: x[0])
    lines = ["Date,Description,Amount,Category"]
    for d, desc, amt, cat in rows:
        lines.append(f"{d.isoformat()},{desc},{amt:.2f},{cat}")
    return "\n".join(lines).encode("utf-8")


def generate_test_pdf():
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas as pdf_canvas

    buf = io.BytesIO()
    c = pdf_canvas.Canvas(buf, pagesize=A4)
    width, height = A4
    c.setFont("Helvetica-Bold", 16)
    c.drawString(50, height - 50, "Test Bank Statement")
    c.setFont("Helvetica", 10)
    c.drawString(50, height - 70, f"Statement period: {date.today() - timedelta(days=180)} - {date.today()}")
    c.drawString(50, height - 85, "Test statement with subscriptions - Netflix, Yandex Plus, IVI, etc.")
    y = height - 120
    c.setFont("Helvetica-Bold", 11)
    c.drawString(50, y, "Date")
    c.drawString(150, y, "Description")
    c.drawString(400, y, "Amount")
    c.setFont("Helvetica", 10)
    y -= 20
    csv_data = generate_test_csv().decode("utf-8")
    for line in csv_data.split("\n"):
        if not line or y < 50:
            break
        parts = line.split(",")
        if len(parts) < 4:
            continue
        d, desc, amt, cat = parts
        color = (0.2, 0.5, 0.2) if cat == "Subscription" else (0.5, 0.5, 0.5)
        c.setFillColorRGB(*color)
        c.drawString(50, y, ".".join(reversed(d.split("-"))))
        c.drawString(150, y, desc[:40])
        c.drawString(400, y, f"{amt} RUB")
        c.setFillColorRGB(0, 0, 0)
        y -= 16

    c.showPage()
    c.save()
    return buf.getvalue()


import base64


def generate_test_with_data():
    csv_bytes = generate_test_csv()
    return {
        "csv_text": csv_bytes.decode("utf-8"),
        "pdf_base64": base64.b64encode(generate_test_pdf()).decode(),
    }
