from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output' / 'pdf' / 'plan.pdf'
OUT.parent.mkdir(parents=True, exist_ok=True)

W, H = 595, 842
c = canvas.Canvas(str(OUT), pagesize=(W, H))
c.setTitle('RecruitSage Sensei - Today sprint')
ink, muted, green, red = map(HexColor, ['#14243A', '#526174', '#168451', '#BC4A42'])
c.setFillColor(HexColor('#FFFFFF'))
c.rect(0, 0, W, H, fill=1, stroke=0)

def line(text, y, size=10, bold=False, color=ink, x=44):
    c.setFillColor(color)
    c.setFont('Helvetica-Bold' if bold else 'Helvetica', size)
    c.drawString(x, y, text)

def section(title, y):
    line(title, y, 11, True)
    c.setStrokeColor(HexColor('#D8DEE5'))
    c.line(44, y - 7, 551, y - 7)
    return y - 25

def row(time, title, detail, y):
    line(time, y, 9, True, green)
    line(title, y, 10, True, ink, 116)
    line(detail, y - 15, 9, False, muted, 116)
    return y - 41

line('RECRUITSAGE SENSEI', 791, 11, True, green)
line('Today: one job mission, end to end', 755, 20, True)
line('Personal-use sprint | 30 Oct 2026 | target: a working flow, not a platform rebuild', 732, 9, False, muted)

y = section('Ship outcome', 690)
line('Pick one real job -> inspect evidence -> judge resume -> prepare a truthful copy ->', y, 10)
line('apply through a verified route -> confirm status -> begin Sensei practice.', y - 16, 10)
line('Keep the mission, source links, resume version and practice history in SQLite.', y - 36, 9, False, muted)

y = section('Build order - about 7 focused hours', 602)
y = row('0-60 min', 'Choose mission + lock evidence', 'Live job detail, eligibility, deadline, current application state, Gmail links.', y)
y = row('60-150 min', 'Resume critic + tailored copy', 'Flag unsupported/weak lines; edit a copy; check layout and PDF output.', y)
y = row('150-270 min', 'Application path', 'Discover required fields and upload flow; dry run; submit one job if verified.', y)
y = row('270-360 min', 'Sensei + adaptive prep', 'JD fundamentals, resume defense, saved gaps, time-to-deadline priorities.', y)
y = row('360-420 min', 'Real end-to-end check', 'Verify portal status, resume used, next-session recall and nudge timing.', y)

y = section('Release gates', 349)
line('1  No invented resume claim. Original file retained; edited version is reviewable.', y, 9)
line('2  No duplicate application. Submit only to an eligible, open, unapplied job.', y - 18, 9)
line('3  "Applied" means the portal returned a durable application record.', y - 36, 9)
line('4  Unclear portal flow or CAPTCHA stops submission; mission stays ready to finish.', y - 54, 9)
line('5  Sensei uses the actual JD and submitted resume, then recalls recorded gaps.', y - 72, 9)
line('6  Urgent action timing follows verified deadlines and remaining prep time.', y - 90, 9)

y = section('Current position and decision points', 215)
line('READY', y, 9, True, green)
line('Read-only RecruitSage/Gmail sync, sourced briefing, resume import and Sensei memory.', y, 9, x=90)
line('BLOCKER', y - 20, 9, True, red)
line('No verified application-submit route yet; resume layout editing is not built.', y - 20, 9, x=90)
line('Today we prioritize one successful mission over broad autonomous job coverage.', y - 49, 9, False, muted)
line('Email digest removed. Mac notification did not visibly arrive; do not count it as delivery.', y - 65, 9, False, muted)

c.setStrokeColor(HexColor('#D8DEE5'))
c.line(44, 65, 551, 65)
line('Resume from this plan: complete the first unchecked gate, update evidence, then continue.', 48, 9, True)
c.save()
print(OUT)
