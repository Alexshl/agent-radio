#!/usr/bin/env python3
"""A listener that stops reading for a while, like a player after Pause or a phone in the background.

  stalled-client.py <url> <out.mp3> [--read 20] [--stall 90] [--after 60] [--rcvbuf 65536]

Reads for --read seconds, then does not read at all for --stall seconds (the connection stays open), then reads for --after seconds again.
--rcvbuf is the receive buffer of the socket: a real phone holds a few hundred KB at most, while a loopback test client would otherwise let the
kernel buffer several MB (minutes of audio), which hides what the server does. Writes everything it receives to <out.mp3>; exits when the
server closes the connection (that is what a dropped lagging listener sees).
"""
import argparse
import socket
import sys
import time
import urllib.parse

ap = argparse.ArgumentParser()
ap.add_argument("url")
ap.add_argument("out")
ap.add_argument("--read", type=float, default=20)
ap.add_argument("--stall", type=float, default=90)
ap.add_argument("--after", type=float, default=60)
ap.add_argument("--rcvbuf", type=int, default=65536)
ap.add_argument("--ua", default="agent-radio-lagtest")
a = ap.parse_args()

u = urllib.parse.urlsplit(a.url)
sock = socket.socket()
sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, a.rcvbuf)  # before connect: it also fixes the advertised window
sock.settimeout(10)
sock.connect((u.hostname, u.port or (443 if u.scheme == "https" else 80)))
path = (u.path or "/") + ("?" + u.query if u.query else "")
sock.sendall(f"GET {path} HTTP/1.0\r\nHost: {u.netloc}\r\nUser-Agent: {a.ua}\r\n\r\n".encode())

out = open(a.out, "wb")
header = b""


def pump(seconds):
    """Reads for `seconds`; returns False when the server closed the connection."""
    global header
    end = time.time() + seconds
    while time.time() < end:
        try:
            chunk = sock.recv(4096)
        except socket.timeout:
            continue
        if not chunk:
            return False
        if b"\r\n\r\n" not in header and len(header) < 8192:
            header += chunk
            if b"\r\n\r\n" in header:
                chunk = header.split(b"\r\n\r\n", 1)[1]
            else:
                continue
        out.write(chunk)
        out.flush()
    return True


alive = pump(a.read)
if alive:
    time.sleep(a.stall)
    alive = pump(a.after)
print("server closed the connection" if not alive else "still connected at the end", file=sys.stderr)
out.close()
sock.close()
