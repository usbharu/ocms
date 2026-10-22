"""Run inside the inference image; outputs only synthetic test fixtures to /tmp/fixtures."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path('/tmp/fixtures')
root.mkdir(exist_ok=True)
image = Image.new('RGB', (640, 400), '#e7f3ff')
draw = ImageDraw.Draw(image)
draw.rectangle((0, 300, 640, 400), fill='#777777')
draw.rounded_rectangle((110, 170, 540, 310), radius=30, fill='#e62424')
draw.polygon([(210, 170), (265, 100), (405, 100), (460, 170)], fill='#e62424')
draw.polygon([(235, 166), (278, 115), (333, 115), (333, 166)], fill='#aacbdd')
draw.polygon([(347, 166), (347, 115), (395, 115), (434, 166)], fill='#aacbdd')
for x in (220, 445):
    draw.ellipse((x-40, 270, x+40, 350), fill='black')
    draw.ellipse((x-20, 290, x+20, 330), fill='#cccccc')
image.save(root / 'car.png')
image.resize((480, 300)).save(root / 'car-copy.jpg', quality=86)
fish = Image.new('RGB', (640, 400), '#124c84')
draw = ImageDraw.Draw(fish)
draw.ellipse((150, 100, 470, 300), fill='#f2b54c')
draw.polygon([(440, 200), (580, 90), (580, 310)], fill='#f2b54c')
draw.ellipse((205, 155, 225, 175), fill='black')
fish.save(root / 'fish.png')
text = Image.new('RGB', (1400, 700), 'white')
draw = ImageDraw.Draw(text)
font = ImageFont.load_default(size=78)
draw.text((80, 180), 'ORCHID ARCHIVE', fill='black', font=font)
draw.text((80, 300), 'Scanned document for search', fill='black', font=ImageFont.load_default(size=48))
text.save(root / 'ocr.png')
text.save(root / 'scan.pdf', 'PDF', resolution=140)
# Minimal text-layer PDF, with a valid xref table and built-in Helvetica.
stream = b'BT /F1 28 Tf 60 700 Td (CATALOG ORCHID TEXT LAYER) Tj ET'
objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    b'<< /Length '+str(len(stream)).encode()+b' >>\nstream\n'+stream+b'\nendstream']
pdf = bytearray(b'%PDF-1.4\n'); offsets = [0]
for i, obj in enumerate(objects, 1):
    offsets.append(len(pdf)); pdf += f'{i} 0 obj\n'.encode()+obj+b'\nendobj\n'
xref = len(pdf); pdf += b'xref\n0 6\n0000000000 65535 f \n'
for offset in offsets[1:]: pdf += f'{offset:010d} 00000 n \n'.encode()
pdf += f'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
(root / 'text.pdf').write_bytes(pdf)
print('Created synthetic images and PDFs.')
