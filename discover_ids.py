"""FotMob Nations League ve WCQ ID'lerini arar."""
import requests
import time

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
}

BASE_URL = "https://www.fotmob.com/api/data/leagues"

# Discovery scripti 1-300 arasi buldu. 300-1500 ve özel ID'leri tara
# Nations League tipik olarak 1007 diye biliniyordu, geniş tarama yap
candidates = (
    list(range(301, 600)) + 
    list(range(600, 1000, 2)) + 
    list(range(1000, 2000, 5))
)

found = {}
for lid in candidates:
    try:
        r = requests.get(BASE_URL, params={"id": lid}, headers=HEADERS, timeout=8)
        if r.status_code == 200:
            d = r.json()
            det = d.get("details") or {}
            if det:
                name = det.get("name") or "unknown"
                country = det.get("country") or ""
                seasons = d.get("allAvailableSeasons", [])
                if country == "INT" or any(kw in name.lower() for kw in 
                        ["nations", "world cup qual", "wcq", "qualifier", "qualifying"]):
                    print(f"  ID {lid:5d}: {name} [{country}] | seasons: {seasons[:5]}")
                    found[lid] = name
    except Exception:
        pass
    time.sleep(0.2)

print(f"\nToplam: {len(found)} yarışma bulundu")
print(found)
