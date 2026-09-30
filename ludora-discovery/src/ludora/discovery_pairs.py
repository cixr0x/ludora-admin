"""Discovery URL identity and public visibility decisions."""
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
    item_id: int | None = None
    is_boardgame_confirmed: bool = False
    is_boardgame: bool = False
    availability: str = "unknown"
    processed_at: str | None = None
    processing_error: str = ""

    @property
    def discovered_url(self) -> str:
        return self.source_url_origin or self.source_url

    @property
    def usability_tier(self) -> int:
        matched_boardgame = self.item_id is not None and self.is_boardgame and self.is_boardgame_confirmed
        if matched_boardgame and self.listing_status == "LISTED":
            return 0
        return 1 if matched_boardgame else 2


def reconcile_discovery_pairs(rows: list[DiscoveryPairState], current_id: int, *, allow_activation: bool) -> list[DiscoveryPairState]:
    """Hide old source history and select among visible rows and this run's candidate.

    Hidden completed rows are never considered for promotion. The caller grants
    activation only when preparation observed a new, unfinished, or failed pair.
    """
    current = next(row for row in rows if row.id == current_id)
    states = {row.id: row for row in rows}
    if current.processed_at is None or current.processing_error:
        return []

    for row in rows:
        if row.id != current_id and row.discovered_url == current.discovered_url and row.store_active:
            states[row.id] = replace(row, store_active=False)

    if not allow_activation:
        return [states[row.id] for row in rows if states[row.id] != row]

    target_rows = [row for row in states.values() if row.source_url == current.source_url]
    eligible = [row for row in target_rows if row.listing_status != "REJECTED"
                and not row.processing_error and (row.store_active or row.id == current_id)]
    winner = min(eligible, key=lambda row: (
        row.usability_tier, row.availability == "unavailable",
        row.source_url_origin is not None, row.id,
    ), default=None)
    for row in target_rows:
        if row.store_active and (winner is None or row.id != winner.id):
            states[row.id] = replace(row, store_active=False)
    if winner is not None and winner.id == current_id and not current.store_active:
        states[current_id] = replace(current, store_active=True)

    return [states[row.id] for row in rows if states[row.id] != row]
