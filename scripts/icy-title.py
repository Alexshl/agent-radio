#!/usr/bin/env python3
"""Prints the ICY StreamTitle values a player (VLC) would see: icy-title.py <url> [seconds=8]. Exit 1 when none arrived."""
import http.client
import re
import sys
import time
import urllib.parse

url = sys.argv[1]
secs = float(sys.argv[2]) if len(sys.argv) > 2 else 8
u = urllib.parse.urlsplit(url)
conn = (http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection)(u.hostname, u.port, timeout=10)
conn.request("GET", u.path + ("?" + u.query if u.query else ""), headers={"Icy-MetaData": "1", "User-Agent": "agent-radio-monitor"})
r = conn.getresponse()
metaint = int(r.getheader("icy-metaint") or 0)
if r.status != 200 or not metaint:
    print(f"no ICY metadata (status {r.status}, icy-metaint {metaint})", file=sys.stderr)
    sys.exit(1)
end = time.time() + secs
titles = []
while time.time() < end:
    r.read(metaint)
    n = r.read(1)[0] * 16
    if n:
        m = re.search(rb"StreamTitle='(.*?)';", r.read(n).rstrip(b"\0"), re.S)
        if m:
            titles.append(m.group(1).decode("utf8", "replace"))
conn.close()
for t in dict.fromkeys(titles):
    print(t)
sys.exit(0 if titles else 1)
