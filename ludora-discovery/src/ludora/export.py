from __future__ import annotations

import csv
import json
from pathlib import Path

from ludora.models import CandidateAuditRecord, StoreRecord


def write_outputs(
    records: list[StoreRecord],
    output_dir: str | Path,
    basename: str = "boardgame_stores_mx",
) -> tuple[Path, Path]:
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    csv_path = output_path / f"{basename}.csv"
    json_path = output_path / f"{basename}.json"

    with csv_path.open("w", encoding="utf-8", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=StoreRecord.output_fields())
        writer.writeheader()
        for record in records:
            writer.writerow(record.to_output_dict())

    with json_path.open("w", encoding="utf-8") as json_file:
        json.dump([record.to_output_dict() for record in records], json_file, ensure_ascii=False, indent=2)
        json_file.write("\n")

    return csv_path, json_path


def write_audit_outputs(
    audit_records: list[CandidateAuditRecord],
    output_dir: str | Path,
    basename: str = "candidate_audit",
) -> tuple[Path, Path]:
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    csv_path = output_path / f"{basename}.csv"
    json_path = output_path / f"{basename}.json"

    with csv_path.open("w", encoding="utf-8", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=CandidateAuditRecord.output_fields())
        writer.writeheader()
        for record in audit_records:
            writer.writerow(record.to_output_dict())

    with json_path.open("w", encoding="utf-8") as json_file:
        json.dump([record.to_output_dict() for record in audit_records], json_file, ensure_ascii=False, indent=2)
        json_file.write("\n")

    return csv_path, json_path
