#!/usr/bin/env python3
"""Reads an MP3 stream for N seconds and checks it: enough bytes, valid MP3 frames, no gaps in the arrival of the data.

  stream-probe.py <url> [--secs 5] [--min-bytes 20000] [--max-gap 3] [--ua agent-radio-monitor] [--out file.mp3] [--min-rate 0]

--min-rate: minimum average bytes per second over the whole read (0 = not checked).
--max-gap : the longest pause between two chunks, in seconds.
Prints one JSON line; exit 0 when everything holds, 1 otherwise, 2 when the stream cannot be opened.
The default User-Agent is the watchdog's monitor one: icecast connections with it are not counted as listeners (see src/server/icecast.ts).
Standard library only. Python 3.8+.
"""
import argparse
import http.client
import json
import sys
import time
import urllib.parse

# MPEG-1 layer III: bitrate (kbps) and sample rate (Hz) tables; MPEG-2/2.5 layer III for completeness
BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
RATES = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}


def frame_len(h):
    """Length of the layer III frame whose 4-byte header is h, or 0 when h is not a valid header."""
    if h[0] != 0xFF or (h[1] & 0xE0) != 0xE0:
        return 0
    version = (h[1] >> 3) & 3  # 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    layer = (h[1] >> 1) & 3  # 1 = layer III
    if version == 1 or layer != 1:
        return 0
    br = (BITRATES_V1 if version == 3 else BITRATES_V2)[(h[2] >> 4) & 15]
    sr_i = (h[2] >> 2) & 3
    if br == 0 or sr_i == 3:
        return 0
    sr = RATES[version][sr_i]
    pad = (h[2] >> 1) & 1
    return (144 if version == 3 else 72) * br * 1000 // sr + pad


def valid_mp3(data):
    """True when the data holds at least 5 consecutive MP3 frames (an ID3 tag in front is skipped)."""
    pos = 0
    if data[:3] == b"ID3" and len(data) > 10:
        size = (data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9]
        pos = 10 + size
    limit = min(len(data), pos + 8192)
    while pos < limit - 4:
        n = frame_len(data[pos : pos + 4])
        if n:
            p, ok = pos, 0
            while p + 4 <= len(data) and frame_len(data[p : p + 4]) and ok < 5:
                p += frame_len(data[p : p + 4])
                ok += 1
            if ok >= 5:
                return True
        pos += 1
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("--secs", type=float, default=5)
    ap.add_argument("--min-bytes", type=int, default=20000)
    ap.add_argument("--max-gap", type=float, default=3)
    ap.add_argument("--min-rate", type=float, default=0)
    ap.add_argument("--ua", default="agent-radio-monitor")
    ap.add_argument("--out")
    a = ap.parse_args()

    u = urllib.parse.urlsplit(a.url)
    conn_cls = http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection
    started = time.monotonic()
    try:
        conn = conn_cls(u.hostname, u.port or (443 if u.scheme == "https" else 80), timeout=10)
        conn.request("GET", (u.path or "/") + ("?" + u.query if u.query else ""), headers={"User-Agent": a.ua})
        resp = conn.getresponse()
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"cannot open the stream: {e}"}))
        return 2
    if resp.status != 200:
        print(json.dumps({"ok": False, "error": f"HTTP {resp.status}"}))
        return 2

    data = bytearray()
    last = time.monotonic()
    first = None
    max_gap = 0.0
    ended_early = False
    deadline = started + a.secs
    out = open(a.out, "wb") if a.out else None
    try:
        while time.monotonic() < deadline:
            conn.sock.settimeout(max(0.5, deadline - time.monotonic() + 1))
            try:
                chunk = resp.read1(4096)
            except Exception:  # noqa: BLE001
                chunk = b""
            now = time.monotonic()
            if not chunk:
                ended_early = now < deadline - 0.5
                break
            if first is None:
                first = now - started
            else:
                max_gap = max(max_gap, now - last)
            last = now
            data += chunk
            if out:
                out.write(chunk)
        # a stall that lasts to the end of the read is a gap too
        max_gap = max(max_gap, time.monotonic() - last)
    finally:
        if out:
            out.close()
        conn.close()

    secs = time.monotonic() - started
    rate = len(data) / secs if secs else 0
    mp3 = valid_mp3(bytes(data))
    problems = []
    if len(data) < a.min_bytes:
        problems.append(f"only {len(data)} bytes (need {a.min_bytes})")
    if not mp3:
        problems.append("not valid MP3")
    if max_gap > a.max_gap:
        problems.append(f"gap of {max_gap:.1f}s (limit {a.max_gap}s)")
    if a.min_rate and rate < a.min_rate:
        problems.append(f"average {rate:.0f} B/s (need {a.min_rate:.0f})")
    if ended_early:
        problems.append("the stream ended before the end of the read")
    print(
        json.dumps(
            {
                "ok": not problems,
                "bytes": len(data),
                "secs": round(secs, 1),
                "rate_bps": round(rate),
                "max_gap_s": round(max_gap, 2),
                "first_byte_s": None if first is None else round(first, 2),
                "valid_mp3": mp3,
                "ended_early": ended_early,
                "problems": problems,
            }
        )
    )
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
