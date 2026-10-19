"""Regenerate tests/fixtures/invoice-ro.pdf (compressed streams, embedded font, Romanian diacritics).

Usage: python3 scripts/make-test-pdf.py   (needs: pip install reportlab)
"""
from pathlib import Path
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
out = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "invoice-ro.pdf"
pdfmetrics.registerFont(TTFont("DejaVu", FONT))
c = canvas.Canvas(str(out), pagesize=A4, pageCompression=1, invariant=1)
c.setFont("DejaVu", 11)
lines = [
    "FACTURĂ FISCALĂ  Seria FCT nr. 0042  Data: 15.10.2026",
    "Furnizor: Exemplu Furnizor SRL  CIF: RO14399840  Reg. Com.: J40/372/2002",
    "Adresă: Șoseaua Virtuții nr. 148, București, Sector 6",
    "Client: Firma Mea SRL  CIF: RO18547290  Brașov, județul Brașov",
    "Nr. crt.  Denumire                      UM   Cant.  Preț     Valoare   TVA 21%",
    "1         Servicii găzduire VPS octombrie buc  1      100,00   100,00    21,00",
    "Total fără TVA: 100,00 lei   Total TVA: 21,00 lei   Total de plată: 121,00 lei",
    "Termen de plată: 30.10.2026   IBAN: RO49AAAA1B31007593840000",
]
y = 800
for line in lines:
    c.drawString(40, y, line)
    y -= 22
c.showPage()
c.save()
print("wrote", out, out.stat().st_size, "bytes")
