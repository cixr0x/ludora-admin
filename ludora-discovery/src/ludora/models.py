from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


StoreCandidateStatus = Literal["PENDING", "ACCEPTED", "REJECTED"]
ItemCandidateType = Literal["unknown", "base_game", "expansion"]
StoreItemListingStatus = Literal["PENDING", "LISTED", "UNLISTED", "REJECTED"]
ItemMatchSource = Literal["", "LOCAL", "BGG", "NONE"]


@dataclass(frozen=True)
class SearchResult:
    title: str
    url: str
    description: str = ""
    query: str = ""


@dataclass(frozen=True)
class CandidateDecision:
    accepted: bool
    confidence: float
    reasons: tuple[str, ...]


@dataclass
class SiteMetadata:
    store_name: str = ""
    instagram_url: str = ""
    facebook_url: str = ""
    city: str = ""
    state: str = ""
    country: str = "Mexico"
    store_logo: str = ""
    page_text: str = ""
    internal_links: list[str] = field(default_factory=list)


@dataclass
class StoreRecord:
    store_name: str
    canonical_domain: str
    website_url: str
    instagram_url: str
    facebook_url: str
    city: str
    state: str
    country: str
    store_logo: str
    confidence: float
    status: StoreCandidateStatus = "PENDING"
    source_queries: list[str] = field(default_factory=list)
    evidence: list[str] = field(default_factory=list)

    @staticmethod
    def output_fields() -> list[str]:
        return [
            "store_name",
            "canonical_domain",
            "website_url",
            "instagram_url",
            "facebook_url",
            "city",
            "state",
            "country",
            "store_logo",
            "status",
            "confidence",
            "source_queries",
            "evidence",
        ]

    def to_output_dict(self) -> dict[str, str]:
        return {
            "store_name": self.store_name,
            "canonical_domain": self.canonical_domain,
            "website_url": self.website_url,
            "instagram_url": self.instagram_url,
            "facebook_url": self.facebook_url,
            "city": self.city,
            "state": self.state,
            "country": self.country,
            "store_logo": self.store_logo,
            "status": self.status,
            "confidence": f"{self.confidence:.2f}",
            "source_queries": " | ".join(sorted(set(self.source_queries))),
            "evidence": " | ".join(self.evidence),
        }


@dataclass
class CandidateAuditRecord:
    canonical_domain: str
    website_url: str
    store_name: str
    accepted: bool
    confidence: float
    reasons: list[str] = field(default_factory=list)
    source_queries: list[str] = field(default_factory=list)
    title: str = ""
    description: str = ""

    @staticmethod
    def output_fields() -> list[str]:
        return [
            "canonical_domain",
            "website_url",
            "store_name",
            "accepted",
            "confidence",
            "reasons",
            "source_queries",
            "title",
            "description",
        ]

    def to_output_dict(self) -> dict[str, str]:
        return {
            "canonical_domain": self.canonical_domain,
            "website_url": self.website_url,
            "store_name": self.store_name,
            "accepted": str(self.accepted),
            "confidence": f"{self.confidence:.2f}",
            "reasons": " | ".join(self.reasons),
            "source_queries": " | ".join(sorted(set(self.source_queries))),
            "title": self.title,
            "description": self.description,
        }


@dataclass
class DiscoveryItemCandidateRecord:
    store_id: int | None
    source_url: str
    title: str
    source_listing_url: str = ""
    publisher: str = ""
    description: str = ""
    item_id: int | None = None
    item_type: ItemCandidateType = "unknown"
    min_players: int | None = None
    max_players: int | None = None
    min_minutes: int | None = None
    max_minutes: int | None = None
    min_age: int | None = None
    language: str = ""
    language_source: str = ""
    language_evidence: str = ""
    image_url: str = ""
    listing_status: StoreItemListingStatus = "PENDING"
    raw_price: str = ""
    price: str = ""
    price_source: str = "none"
    currency: str = "MXN"
    availability: str = "unknown"
    availability_source: str = "none"
    store_sku: str = ""
    raw_payload: dict[str, object] = field(default_factory=dict)
    is_boardgame: bool = False
    is_boardgame_confirmed: bool = False
    category_confidence: float | None = None
    classification_reasons: list[str] = field(default_factory=list)
    match_source: ItemMatchSource = ""
    matched_bgg_id: int | None = None
    matched_name: str = ""
    match_score: float | None = None
    match_reasons: list[str] = field(default_factory=list)
    match_payload: dict[str, object] = field(default_factory=dict)
    matched_at: str | None = None
    processed_at: str | None = None
    processing_error: str = ""

    def to_db_dict(self) -> dict[str, object]:
        return {
            "store_id": self.store_id,
            "source_url": self.source_url,
            "source_listing_url": self.source_listing_url,
            "title": self.title,
            "publisher": self.publisher,
            "description": self.description,
            "item_id": self.item_id,
            "item_type": self.item_type,
            "min_players": self.min_players,
            "max_players": self.max_players,
            "min_minutes": self.min_minutes,
            "max_minutes": self.max_minutes,
            "min_age": self.min_age,
            "language": self.language,
            "language_source": self.language_source,
            "language_evidence": self.language_evidence,
            "image_url": self.image_url,
            "listing_status": self.listing_status,
            "raw_price": self.raw_price,
            "price": self.price or None,
            "price_source": self.price_source,
            "currency": self.currency,
            "availability": self.availability,
            "availability_source": self.availability_source,
            "store_sku": self.store_sku,
            "raw_payload": self.raw_payload,
            "is_boardgame": self.is_boardgame,
            "is_boardgame_confirmed": self.is_boardgame_confirmed,
            "category_confidence": self.category_confidence,
            "classification_reasons": self.classification_reasons,
            "match_source": self.match_source,
            "matched_bgg_id": self.matched_bgg_id,
            "matched_name": self.matched_name,
            "match_score": self.match_score,
            "match_reasons": self.match_reasons,
            "match_payload": self.match_payload,
            "matched_at": self.matched_at,
            "processed_at": self.processed_at,
            "processing_error": self.processing_error,
        }
