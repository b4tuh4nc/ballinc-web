"""Mevcut bilinen ID'leri test eder."""
import requests, json

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Accept": "application/json",
}

tests = [
    (50, "2024"),    # EURO
    (77, "2026"),    # World Cup
    (289, "2025"),   # AFCON
    (44, "2024"),    # Copa America
    (290, "2027"),   # Asian Cup
    (298, "2025"),   # CONCACAF Gold Cup
]

for lid, season in tests:
    r = requests.get("https://www.fotmob.com/api/data/leagues", 
                     params={"id": lid, "season": season}, headers=HEADERS, timeout=15)
    d = r.json()
    det = d.get("details", {}) or {}
    fixtures = d.get("fixtures", {}) or {}
    matches = fixtures.get("allMatches") or []
    avail = d.get("allAvailableSeasons", [])
    name = det.get("name", "?")
    print(f"ID {lid} ({season}): {name} | {len(matches)} mac | seasons: {avail[:5]}")
