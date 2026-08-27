"""Ballinc pipeline paketi.

Windows konsolu varsayılan olarak cp1254 kullanıyor ve Türkçe karakterlerle
ok/onay işaretlerinde çöküyor. Tüm giriş noktaları `python -m pipeline.<modül>`
şeklinde çalıştığı için akışları burada bir kez UTF-8'e sabitliyoruz.
"""

import sys

for _stream in (sys.stdout, sys.stderr):
    reconfigure = getattr(_stream, "reconfigure", None)
    if reconfigure is not None:
        try:
            reconfigure(encoding="utf-8")
        except (ValueError, OSError):
            pass
