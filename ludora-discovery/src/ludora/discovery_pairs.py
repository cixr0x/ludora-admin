"""Discovery URL identity and visibility decisions, independent of persistence."""
from __future__ import annotations

from dataclasses import dataclass, replace
from urllib.parse import urldefrag


def discovery_url_pair(discovered_url: str, final_url: str) -> tuple[str | None, str]:
    source = urldefrag(discovered_url).url
    target = urldefrag(final_url).url
    return (source if source != target else None, target)


@dataclass(frozen=True)
class DiscoveryPairState:
    id: int
    source_url: str
    source_url_origin: str | None
    store_active: bool
    listing_status: str
    hidden_reason: str | None = None
    duplicate_of_id: int | None = None
    superseded_by_id: int | None = None
    visibility_before_suppression: bool | None = None
    item_id: int | None = None
    is_boardgame_confirmed: bool = False
    processing_complete: bool = True
    is_boardgame: bool = False
    availability: str = "unknown"

    @property
    def discovered_url(self) -> str:
        return self.source_url_origin or self.source_url

    @property
    def eligible(self) -> bool:
        visible = self.store_active if self.visibility_before_suppression is None else self.visibility_before_suppression
        return visible and self.listing_status != "REJECTED" and self.processing_complete

    @property
    def usability_tier(self) -> int:
        matched_boardgame = self.item_id is not None and self.is_boardgame and self.is_boardgame_confirmed
        if matched_boardgame and self.listing_status == "LISTED":
            return 0
        return 1 if matched_boardgame else 2


def reconcile_discovery_pairs(rows: list[DiscoveryPairState], current_id: int) -> list[DiscoveryPairState]:
    """Return only changed rows; unrelated inactive intent is never promoted."""
    current = next(row for row in rows if row.id == current_id)
    states = {}
    for row in rows:
        if row.discovered_url == current.discovered_url:
            row = replace(row, hidden_reason=None, duplicate_of_id=None, superseded_by_id=None, processing_complete=True) if row.id == current_id else _suppress(row, "superseded", superseded_by_id=current_id)
        states[row.id] = row

    for target in {row.source_url for row in rows}:
        group = [row for row in states.values() if row.source_url == target]
        eligible = [row for row in group if row.eligible and row.hidden_reason not in {"superseded", "pending"}]
        winner = min(eligible, key=lambda row: (row.usability_tier, row.availability == "unavailable", row.source_url_origin is not None, row.hidden_reason is not None or not row.store_active, row.id), default=None)
        for row in group:
            if row.hidden_reason in {"superseded", "pending"}:
                continue
            if winner is not None and row.id != winner.id:
                states[row.id] = _suppress(row, "duplicate", duplicate_of_id=winner.id)
            elif row.visibility_before_suppression is not None:
                states[row.id] = replace(row, store_active=row.visibility_before_suppression, hidden_reason=None, duplicate_of_id=None, superseded_by_id=None, visibility_before_suppression=None)

    return [states[row.id] for row in rows if states[row.id] != row]


def _suppress(row: DiscoveryPairState, reason: str, *, duplicate_of_id: int | None = None, superseded_by_id: int | None = None) -> DiscoveryPairState:
    original_active = row.store_active if row.visibility_before_suppression is None else row.visibility_before_suppression
    return replace(row, store_active=False, hidden_reason=reason, duplicate_of_id=duplicate_of_id, superseded_by_id=superseded_by_id, visibility_before_suppression=original_active)
