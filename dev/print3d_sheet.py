# Contact sheet of the 3D print dialog screenshots (tests/print3d_dialog.mjs output) -> shots/p3_sheet.jpg
#   python dev/print3d_sheet.py
from PIL import Image, ImageDraw, ImageFont
import os

S = 'shots'
desk = [('p3_lineart_plaque_desk_light.png', 'A plaque · Line art · light'), ('p3_lineart_wire_desk_dark.png', 'B wire · Line art · dark'),
        ('p3_bl_spiral_litho_desk_light.png', 'C lithophane lit from behind · spiral'), ('p3_lineart_cutter_desk_light.png', 'D cutter + stamp · Line art'),
        ('p3_bb_lineart_plaque_desk_light.png', 'black on black: warning + one-tap fix'), ('p3_real_plaque-off_desk_dark.png', 'Realistic: A and B not offered, why'),
        ('p3_mini_lineart_plaque_desk_light.png', 'A1 mini: fit warning, swap at Z 2.4 mm'), ('p3_watch_lineart_plaque_desk_dark.png', 'Watch it print (timelapse)')]
mob = [('p3_lineart_plaque_mob_dark.png', 'mobile dark'), ('p3_lineart_plaque_mob_dark_b.png', 'mobile dark, report'),
       ('p3_real_litho_mob_light.png', 'mobile light, Realistic'), ('p3_spiral_cutter_mob_light.png', 'mobile light, cutter')]
TW, TH = 720, 470
MW, MH = 234, 507
try:
    font = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 20)
except Exception:
    font = ImageFont.load_default()
cols = 4
rows = (len(desk) + cols - 1) // cols
W = cols * TW + (cols + 1) * 16
H = rows * (TH + 34) + (MH + 34) + (rows + 2) * 16
sheet = Image.new('RGB', (W, H), (238, 235, 229))
d = ImageDraw.Draw(sheet)
for k, (f, cap) in enumerate(desk):
    p = os.path.join(S, f)
    if not os.path.exists(p):
        continue
    im = Image.open(p).convert('RGB')
    im = im.crop((200, 16, 1240, 924)) if im.width >= 1400 else im
    im.thumbnail((TW, TH))
    x = 16 + (k % cols) * (TW + 16); y = 16 + (k // cols) * (TH + 50)
    sheet.paste(im, (x, y))
    d.text((x, y + im.height + 6), cap, fill=(40, 38, 34), font=font)
y0 = 16 + rows * (TH + 50)
for k, (f, cap) in enumerate(mob):
    p = os.path.join(S, f)
    if not os.path.exists(p):
        continue
    im = Image.open(p).convert('RGB')
    im.thumbnail((MW, MH))
    x = 16 + k * (MW + 24)
    sheet.paste(im, (x, y0))
    d.text((x, y0 + im.height + 6), cap, fill=(40, 38, 34), font=font)
sheet.save(os.path.join(S, 'p3_sheet.jpg'), quality=86)
print('shots/p3_sheet.jpg', sheet.size)
