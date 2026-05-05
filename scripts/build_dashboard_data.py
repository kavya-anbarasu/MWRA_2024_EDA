"""Build the static data bundle used by the MWRA dashboard.

The site is intentionally static, so this script converts the local CSV/XLSX
inputs into one browser-readable JavaScript file.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
OUT_FILE = ROOT / "assets" / "mwra_dashboard_data.js"

STATION_CATEGORIES = {
    "Mass Bay Nearfield": ["N01", "N04", "N07", "N18", "N21"],
    "Mass Bay Farfield": ["F06", "F10", "F13", "F15", "F22"],
    "Boston Harbor Outlet": ["F23"],
    "Cape Cod Bay": ["F01", "F02", "F29"],
}

CATEGORY_COLORS = {
    "Mass Bay Nearfield": "#2f6f88",
    "Mass Bay Farfield": "#c97939",
    "Boston Harbor Outlet": "#6e8b3d",
    "Cape Cod Bay": "#8e5ea2",
    "Other": "#77818c",
}

DEPTH_BANDS = [
    ("Surface (0-5m)", 0, 5),
    ("Mid-water (5-20m)", 5, 20),
    ("Deep (>20m)", 20, None),
]

PROBE_PARAMETERS = [
    "TEMP",
    "SAL",
    "DISS_OXYGEN",
    "O2_PCT_SAT",
    "CHLA_FLU_CALIB",
    "PH",
    "CONDTVY",
    "TRANS",
    "PAR_DEPTH",
]

LAB_PARAMETERS = [
    "NH4",
    "NO2",
    "NO3",
    "NO3_NO2",
    "TDN",
    "TN",
    "PON",
    "PO4",
    "TDP",
    "PARTP",
    "TPHOS",
    "SIO4",
    "POC",
    "CHLA",
    "PHAE",
]

PARAMETER_ALIASES = {
    "NO3+NO2": "NO3_NO2",
    "FLUORESCENCE": "CHLA_FLU_CALIB",
    "FLU_RAW": "CHLA_FLU_RAW",
    "LIGHT": "PAR_DEPTH",
}

PARAMETER_FALLBACKS = {
    "TEMP": ("Temperature", "deg C"),
    "SAL": ("Salinity", "PSU"),
    "DISS_OXYGEN": ("Dissolved oxygen", "mg/L"),
    "O2_PCT_SAT": ("Oxygen saturation", "%"),
    "CHLA_FLU_CALIB": ("Probe chlorophyll-a", "ug/L"),
    "PH": ("pH", "standard units"),
    "CONDTVY": ("Conductivity", "mS/cm"),
    "TRANS": ("Transmissivity", "%"),
    "PAR_DEPTH": ("Irradiance at depth", "uE m-2 s-1"),
    "NH4": ("Ammonium", "uM"),
    "NO2": ("Nitrite", "uM"),
    "NO3": ("Nitrate", "uM"),
    "NO3_NO2": ("Nitrate + nitrite", "uM"),
    "TDN": ("Total dissolved nitrogen", "uM"),
    "TN": ("Total nitrogen", "uM"),
    "PON": ("Particulate organic nitrogen", "uM"),
    "PO4": ("Phosphate", "uM"),
    "TDP": ("Total dissolved phosphorus", "uM"),
    "PARTP": ("Particulate phosphorus", "uM"),
    "TPHOS": ("Total phosphorus", "uM"),
    "SIO4": ("Silicate", "uM"),
    "POC": ("Particulate organic carbon", "uM"),
    "CHLA": ("Extracted chlorophyll-a", "ug/L"),
    "PHAE": ("Phaeophytin", "ug/L"),
}


def station_category(station: str) -> str:
    for category, stations in STATION_CATEGORIES.items():
        if station in stations:
            return category
    return "Other"


def depth_band(depth: float | None) -> str:
    if depth is None or pd.isna(depth):
        return "Unknown"
    for label, low, high in DEPTH_BANDS:
        if depth >= low and (high is None or depth <= high):
            return label
    return "Unknown"


def load_csv(filename: str) -> pd.DataFrame:
    df = pd.read_csv(DATA_DIR / filename)
    df["STAT_ARRIV"] = pd.to_datetime(
        df["STAT_ARRIV"], format="%d-%b-%Y %H:%M:%S", errors="coerce"
    )
    df = df[df["STAT_ARRIV"].notna()].copy()
    df["date"] = df["STAT_ARRIV"].dt.strftime("%Y-%m-%d")
    df["month"] = df["STAT_ARRIV"].dt.strftime("%Y-%m")
    df["category"] = df["STAT_ID"].map(station_category)
    if "DEPTH" in df.columns:
        df["DEPTH"] = pd.to_numeric(df["DEPTH"], errors="coerce")
        df["depth_band"] = df["DEPTH"].map(depth_band)
    return df


def numeric_clean(df: pd.DataFrame, columns: Iterable[str]) -> pd.DataFrame:
    for column in columns:
        if column in df.columns:
            df[column] = pd.to_numeric(df[column], errors="coerce")
    return df


def clean_value(value):
    if pd.isna(value):
        return None
    if isinstance(value, float):
        return round(value, 5)
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    return value


def records(df: pd.DataFrame, columns: list[str]) -> list[dict]:
    available = [column for column in columns if column in df.columns]
    out = []
    for row in df[available].to_dict(orient="records"):
        out.append({key: clean_value(value) for key, value in row.items()})
    return out


def parameter_metadata() -> dict[str, dict[str, str]]:
    metadata = pd.read_excel(DATA_DIR / "Metadata.xlsx", sheet_name="Lab and probe parameters")
    parameter_lookup: dict[str, dict[str, str]] = {}

    for row in metadata.to_dict(orient="records"):
        raw_code = str(row["PARAM_CODE"]).strip()
        code = PARAMETER_ALIASES.get(raw_code, raw_code)
        parameter_lookup[code] = {
            "code": code,
            "label": str(row["PARAMETER_DEFINITION"]).strip(),
            "unit": str(row["UNITS"]).strip(),
            "source": str(row["LAB_OR_PROBE"]).strip().lower(),
        }

    for code, (label, unit) in PARAMETER_FALLBACKS.items():
        parameter_lookup.setdefault(
            code,
            {
                "code": code,
                "label": label,
                "unit": unit,
                "source": "lab" if code in LAB_PARAMETERS else "probe",
            },
        )

    return parameter_lookup


def station_records(stations: pd.DataFrame, dataframes: dict[str, pd.DataFrame]) -> list[dict]:
    station_rows = []
    for row in stations.to_dict(orient="records"):
        station_id = row["STAT_ID"]
        counts = {
            name: int(df[df["STAT_ID"] == station_id].shape[0])
            for name, df in dataframes.items()
        }
        station_rows.append(
            {
                "id": station_id,
                "study": row["STUDY_ID"],
                "lat": clean_value(row["TARGET_LAT"]),
                "lon": clean_value(row["TARGET_LON"]),
                "description": row["LOC_DESC"],
                "waterDepthM": clean_value(row["AVG_WATER_DEPTH [m]"]),
                "category": station_category(station_id),
                "counts": counts,
            }
        )
    return station_rows


def coverage_by_event(dataframes: dict[str, pd.DataFrame]) -> list[dict]:
    rows = []
    all_events = sorted(
        set().union(*(set(df["EVENT_ID"].dropna().unique()) for df in dataframes.values()))
    )
    for event in all_events:
        event_rows = {"event": event}
        dates = []
        stations = set()
        for name, df in dataframes.items():
            subset = df[df["EVENT_ID"] == event]
            event_rows[f"{name}Records"] = int(subset.shape[0])
            event_rows[f"{name}Stations"] = int(subset["STAT_ID"].nunique())
            if not subset.empty:
                dates.extend(subset["date"].dropna().tolist())
                stations.update(subset["STAT_ID"].dropna().tolist())
        event_rows["date"] = min(dates) if dates else None
        event_rows["stationCount"] = len(stations)
        rows.append(event_rows)
    return rows


def dataset_summary(name: str, df: pd.DataFrame) -> dict:
    return {
        "name": name,
        "records": int(df.shape[0]),
        "events": int(df["EVENT_ID"].nunique()),
        "stations": int(df["STAT_ID"].nunique()),
        "start": df["date"].min(),
        "end": df["date"].max(),
    }


def plankton_records(df: pd.DataFrame, value_column: str) -> list[dict]:
    numeric_clean(df, [value_column, "DEPTH"])
    columns = [
        "EVENT_ID",
        "STAT_ID",
        "date",
        "month",
        "DEPTH",
        "depth_band",
        "category",
        "GROUP_ID",
        "DESCR",
        value_column,
    ]
    return records(df, columns)


def build() -> None:
    downcast = numeric_clean(load_csv("MWRA-DOWNCAST-2024.csv"), PROBE_PARAMETERS)
    downcast["cast"] = "Downcast"
    upcast = numeric_clean(load_csv("MWRA-UPCAST-2024.csv"), PROBE_PARAMETERS)
    upcast["cast"] = "Upcast"
    probe = pd.concat([downcast, upcast], ignore_index=True)

    lab = numeric_clean(load_csv("MWRA-LAB-RESULTS-2024.csv"), LAB_PARAMETERS)
    phyto = load_csv("MWRA-PHYTOPLANKTON-2024.csv")
    zoo = load_csv("MWRA-ZOOPLANKTON.csv")

    stations = pd.read_excel(DATA_DIR / "Metadata.xlsx", sheet_name="Station locations")
    stations = stations.sort_values("STAT_ID").reset_index(drop=True)

    dataframes = {
        "downcast": downcast,
        "upcast": upcast,
        "lab": lab,
        "phyto": phyto,
        "zoo": zoo,
    }

    parameter_lookup = parameter_metadata()
    probe_columns = [
        "EVENT_ID",
        "STAT_ID",
        "STAT_ARRIV",
        "date",
        "month",
        "cast",
        "DEPTH",
        "depth_band",
        "category",
    ] + PROBE_PARAMETERS
    lab_columns = [
        "EVENT_ID",
        "STAT_ID",
        "STAT_ARRIV",
        "date",
        "month",
        "DEPTH",
        "depth_band",
        "category",
    ] + LAB_PARAMETERS

    all_dates = pd.concat(
        [df["STAT_ARRIV"] for df in [downcast, upcast, lab, phyto, zoo]], ignore_index=True
    )

    payload = {
        "generatedAt": pd.Timestamp.utcnow().isoformat(),
        "summary": {
            "start": all_dates.min().strftime("%Y-%m-%d"),
            "end": all_dates.max().strftime("%Y-%m-%d"),
            "stationCount": int(stations["STAT_ID"].nunique()),
            "eventCount": int(
                len(set().union(*(set(df["EVENT_ID"].dropna().unique()) for df in dataframes.values())))
            ),
            "datasets": [dataset_summary(name, df) for name, df in dataframes.items()],
        },
        "categories": [
            {
                "name": name,
                "color": CATEGORY_COLORS[name],
                "stations": station_ids,
            }
            for name, station_ids in STATION_CATEGORIES.items()
        ],
        "parameters": {
            "probe": [parameter_lookup[code] for code in PROBE_PARAMETERS],
            "lab": [parameter_lookup[code] for code in LAB_PARAMETERS],
        },
        "stations": station_records(stations, dataframes),
        "coverage": coverage_by_event(dataframes),
        "records": {
            "probe": records(probe, probe_columns),
            "lab": records(lab, lab_columns),
            "phyto": plankton_records(phyto, "CELLS_PER_L"),
            "zoo": plankton_records(zoo, "IND_PER_M3"),
        },
    }

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    json_text = json.dumps(payload, separators=(",", ":"), ensure_ascii=True)
    OUT_FILE.write_text(
        "window.MWRA_DASHBOARD_DATA = " + json_text + ";\n", encoding="utf-8"
    )
    print(f"Wrote {OUT_FILE.relative_to(ROOT)} ({OUT_FILE.stat().st_size:,} bytes)")


if __name__ == "__main__":
    build()
