"""Where does the start of the fresh capture B sit inside the post-resume capture A? That position (seconds) is how stale A's audio is."""
import array
import math
import subprocess
import sys

a_file, b_file, label = sys.argv[1:4]
a_alive = (sys.argv[4] if len(sys.argv) > 4 else "1") == "1"
RATE = 8000
HOP = 400  # 50 ms -> 20 envelope points per second


def env(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-"],
        capture_output=True,
    ).stdout
    s = array.array("h")
    s.frombytes(raw[: len(raw) // 2 * 2])
    out = []
    for i in range(0, len(s) - HOP, HOP):
        seg = s[i : i + HOP]
        out.append(math.sqrt(sum(x * x for x in seg) / HOP))
    # log scale, then remove the mean
    out = [math.log(1 + v) for v in out]
    m = sum(out) / len(out) if out else 0
    return [v - m for v in out]


A = env(a_file)
B = env(b_file)
print(f"[{label}] decoded: A_post {len(A) / 20:.0f}s, B {len(B) / 20:.0f}s")
WIN = min(len(B), 20 * 25)  # first 25 s of B
if len(A) < WIN or WIN < 20 * 5:
    print(f"[{label}] not enough audio to compare (the connection was dropped: {not a_alive})")
    print("RESULT dropped" if not a_alive else "RESULT unknown")
    sys.exit(0)
tpl = B[:WIN]
tn = math.sqrt(sum(v * v for v in tpl)) or 1
best = (-2, 0)
for off in range(0, len(A) - WIN + 1):
    seg = A[off : off + WIN]
    sn = math.sqrt(sum(v * v for v in seg)) or 1
    c = sum(x * y for x, y in zip(tpl, seg)) / (tn * sn)
    if c > best[0]:
        best = (c, off)
# also the correlation at offset 0 (A already live at resume)
seg0 = A[:WIN]
c0 = sum(x * y for x, y in zip(tpl, seg0)) / (tn * (math.sqrt(sum(v * v for v in seg0)) or 1))
print(f"[{label}] best match: B starts {best[1] / 20:.1f}s into A_post (correlation {best[0]:.2f}); at offset 0: {c0:.2f}")
if best[0] > 0.5:
    print(f"[{label}] => audio delivered after the resume is about {best[1] / 20:.1f}s behind live")
    print(f"RESULT lag={best[1] / 20:.0f}")
elif c0 > 0.5:
    print(f"[{label}] => audio after the resume is live (lag about 0 s)")
    print("RESULT lag=0")
else:
    print(f"[{label}] => no clear match" + (" (connection dropped)" if not a_alive else ""))
    print("RESULT dropped" if not a_alive else "RESULT unknown")
