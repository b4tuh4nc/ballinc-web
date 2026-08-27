"""index.html'deki stil/script bağlantılarına içerik damgası basar.

Sorun: GitHub Pages statik dosyaları `Cache-Control: max-age=600` ile
sunuyor ve tarayıcılar bunu daha da uzun tutabiliyor. Arayüz güncellendiği
halde kullanıcı eski CSS/JS'i görüyordu — "hiçbir şey değişmemiş" hissi
buradan geliyordu.

Çözüm: `style.css?v=<hash>` şeklinde, dosya içeriğinden türeyen bir sürüm
parametresi. İçerik değişmediğinde hash aynı kalır (gereksiz indirme yok),
değiştiğinde URL değişir ve tarayıcı yeniyi çekmek zorunda kalır.

Bu adım yalnızca yayın öncesi çalışır; depodaki index.html damgasız kalır ki
sürekli değişip gürültü yaratmasın.
"""

from __future__ import annotations

import hashlib
import re
import sys

from pipeline.config import WEB_DIR

ASSETS = ("style.css", "app.js")


def content_hash(name: str) -> str | None:
    path = WEB_DIR / name
    if not path.exists():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()[:10]


def main() -> int:
    index = WEB_DIR / "index.html"
    if not index.exists():
        print("web/index.html bulunamadı.")
        return 1

    html = index.read_text(encoding="utf-8")
    stamped = 0

    for name in ASSETS:
        digest = content_hash(name)
        if not digest:
            print(f"  ! {name} yok, atlandı")
            continue
        # Hem damgasız hem daha önce damgalanmış hali yakalanıyor.
        pattern = re.compile(rf"{re.escape(name)}(\?v=[0-9a-f]+)?")
        html, count = pattern.subn(f"{name}?v={digest}", html)
        if count:
            stamped += count
            print(f"  ✓ {name} → v={digest} ({count} bağlantı)")

    if not stamped:
        print("Damgalanacak bağlantı bulunamadı.")
        return 1

    index.write_text(html, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
