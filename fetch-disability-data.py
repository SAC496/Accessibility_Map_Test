#!/usr/bin/env python3
"""
fetch-disability-data.py

Fetches ambulatory disability data from Census Reporter (no API key needed)
and writes disability-data.js to the project folder.

Usage (Python 3.8+, no pip install needed):
    python fetch-disability-data.py
"""

import json
import time
import urllib.request
from datetime import datetime, timezone

CR_BASE    = "https://api.censusreporter.org/1.0/data/show/latest"
TIGER_BASE = ("https://tigerweb.geo.census.gov/arcgis/rest/services"
              "/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer")
PITTSBURGH_BBOX = "-80.37,40.18,-79.68,40.72"

# Census Reporter uses "B18105004" format (no underscore, no trailing E)
DISABILITY_VARS = [
    "B18105004", "B18105007", "B18105010", "B18105013",
    "B18105016", "B18105019", "B18105023", "B18105026",
    "B18105029", "B18105032", "B18105035", "B18105038",
]
TOTAL_VAR = "B18105001"


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "accessibility-map/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def sum_disability(est):
    total = 0
    for v in DISABILITY_VARS:
        val = float(est.get(v) or 0)
        if val > 0:
            total += round(val)
    return total


# ── Step 1: Pittsburgh ZIP codes from TIGERweb (layer 1 = ZCTAs) ─────────────

def get_pittsburgh_zips():
    from urllib.parse import quote
    url = (f"{TIGER_BASE}/1/query"
           f"?geometry={quote(PITTSBURGH_BBOX)}"
           "&geometryType=esriGeometryEnvelope&inSR=4326"
           "&spatialRel=esriSpatialRelIntersects"
           "&outFields=ZCTA5&returnGeometry=false&f=json")
    data = fetch_json(url)
    return sorted({f["attributes"]["ZCTA5"]
                   for f in data.get("features", [])
                   if f.get("attributes", {}).get("ZCTA5")})


# ── Step 2: ZIP disability data from Census Reporter (batches of 25) ─────────

def fetch_zip_data(zips):
    result = {}
    chunks = [zips[i:i+25] for i in range(0, len(zips), 25)]
    for i, chunk in enumerate(chunks):
        print(f"  batch {i+1}/{len(chunks)}...", end="\r", flush=True)
        geo_ids = ",".join(f"86000US{z}" for z in chunk)
        cr      = fetch_json(f"{CR_BASE}?table_ids=B18105&geo_ids={geo_ids}")
        for geoid, tables in cr["data"].items():
            z   = geoid.replace("86000US", "")
            est = tables["B18105"]["estimate"]
            result[z] = {
                "count":    sum_disability(est),
                "totalPop": max(0, round(float(est.get(TOTAL_VAR) or 0))),
            }
        if i < len(chunks) - 1:
            time.sleep(0.3)
    print()
    return result


# ── Step 3: Tract disability data from Census Reporter ────────────────────────

def fetch_tract_data():
    # 140 = census tract summary level; 05000US42003 = Allegheny County PA
    cr     = fetch_json(f"{CR_BASE}?table_ids=B18105&geo_ids=140|05000US42003")
    result = {}
    for geoid, tables in cr["data"].items():
        id11 = geoid.replace("14000US", "")  # strip prefix → 11-char GEOID
        est  = tables["B18105"]["estimate"]
        result[id11] = {
            "count":    sum_disability(est),
            "totalPop": max(0, round(float(est.get(TOTAL_VAR) or 0))),
        }
    return result


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    print("Step 1/3  Getting Pittsburgh ZIPs from TIGERweb...")
    zips = get_pittsburgh_zips()
    print(f"          Found {len(zips)} ZIPs")

    print("Step 2/3  Fetching ZIP disability data from Census Reporter...")
    zipcodes = fetch_zip_data(zips)
    print(f"          Got data for {len(zipcodes)} ZIPs")

    print("Step 3/3  Fetching tract disability data from Census Reporter...")
    tracts = fetch_tract_data()
    print(f"          Got data for {len(tracts)} tracts")

    generated = datetime.now(timezone.utc).isoformat()
    payload = {
        "generated": generated,
        "source":    "Census Reporter / ACS 2022 5-Year, Table B18105 (Ambulatory Difficulty)",
        "note":      "count = estimated people with serious ambulatory difficulty — nearest ACS proxy for wheelchair users",
        "zipcodes":  zipcodes,
        "tracts":    tracts,
    }
    js = (f"// Auto-generated {generated} -- re-run: python fetch-disability-data.py\n"
          f"window.DISABILITY_DATA = {json.dumps(payload, indent=2)};\n")

    with open("disability-data.js", "w", encoding="utf-8") as f:
        f.write(js)

    print(f"\nDone!  disability-data.js  |  {len(zipcodes)} ZIPs, {len(tracts)} tracts")


if __name__ == "__main__":
    main()
