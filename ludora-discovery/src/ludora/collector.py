from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from ludora.brave import BraveSearchClient
from ludora.cancellation import CancellationToken, raise_if_cancelled
from ludora.enrichment import extract_site_metadata, merge_metadata
from ludora.export import write_audit_outputs, write_outputs
from ludora.filtering import (
    canonical_domain,
    classify_store_candidate,
    homepage_url,
    is_blocked_domain,
)
from ludora.models import CandidateAuditRecord, SearchResult, SiteMetadata, StoreRecord
from ludora.queries import build_queries
from ludora.webfetch import fetch_html


@dataclass
class DomainBucket:
    domain: str
    homepage: str
    results: list[SearchResult] = field(default_factory=list)
    queries: set[str] = field(default_factory=set)


@dataclass(frozen=True)
class CollectionSummary:
    records: list[StoreRecord]
    csv_path: Path | None
    json_path: Path | None
    audit_csv_path: Path | None
    audit_json_path: Path | None
    searched_queries: int
    candidate_domains: int


class StoreCandidateRepository(Protocol):
    def upsert_store_candidate(self, record: StoreRecord) -> None:
        ...


def collect_stores(
    api_key: str,
    output_dir: str | Path = "data",
    query_scope: str = "expanded",
    max_queries: int | None = None,
    count: int = 20,
    pages: int = 1,
    request_delay: float = 1.1,
    website_delay: float = 0.3,
    max_enrichment_pages: int = 3,
    include_low_confidence: bool = False,
    verbose: bool = False,
    discovery_repository: StoreCandidateRepository | None = None,
    export_files: bool = False,
    cancellation_token: CancellationToken | None = None,
) -> CollectionSummary:
    queries = build_queries(query_scope)
    if max_queries is not None:
        queries = queries[:max_queries]

    client = BraveSearchClient(api_key)
    buckets: dict[str, DomainBucket] = {}

    for query_index, query in enumerate(queries, start=1):
        raise_if_cancelled(cancellation_token)
        if verbose:
            print(f"[{query_index}/{len(queries)}] Brave search: {query}")
        for offset in range(pages):
            raise_if_cancelled(cancellation_token)
            for result in client.search(query, count=count, offset=offset):
                raise_if_cancelled(cancellation_token)
                domain = canonical_domain(result.url)
                if not domain or is_blocked_domain(domain):
                    continue
                bucket = buckets.setdefault(
                    domain,
                    DomainBucket(domain=domain, homepage=homepage_url(result.url)),
                )
                bucket.results.append(result)
                if result.query:
                    bucket.queries.add(result.query)
            time.sleep(request_delay)

    records, audit_records = _enrich_and_filter_buckets(
        buckets=buckets,
        website_delay=website_delay,
        max_enrichment_pages=max_enrichment_pages,
        include_low_confidence=include_low_confidence,
        verbose=verbose,
        discovery_repository=discovery_repository,
        cancellation_token=cancellation_token,
    )
    records.sort(key=lambda record: (-record.confidence, record.store_name.casefold(), record.canonical_domain))
    audit_records.sort(key=lambda record: (not record.accepted, -record.confidence, record.canonical_domain))
    csv_path = json_path = audit_csv_path = audit_json_path = None
    if export_files:
        csv_path, json_path = write_outputs(records, output_dir)
        audit_csv_path, audit_json_path = write_audit_outputs(audit_records, output_dir)
    return CollectionSummary(
        records=records,
        csv_path=csv_path,
        json_path=json_path,
        audit_csv_path=audit_csv_path,
        audit_json_path=audit_json_path,
        searched_queries=len(queries),
        candidate_domains=len(buckets),
    )


def _enrich_and_filter_buckets(
    buckets: dict[str, DomainBucket],
    website_delay: float,
    max_enrichment_pages: int,
    include_low_confidence: bool,
    verbose: bool,
    discovery_repository: StoreCandidateRepository | None = None,
    cancellation_token: CancellationToken | None = None,
) -> tuple[list[StoreRecord], list[CandidateAuditRecord]]:
    records: list[StoreRecord] = []
    audit_records: list[CandidateAuditRecord] = []
    for index, bucket in enumerate(buckets.values(), start=1):
        raise_if_cancelled(cancellation_token)
        if verbose:
            print(f"[{index}/{len(buckets)}] Enrich: {bucket.domain}")

        metadata, final_url = _enrich_site(bucket.homepage, max_enrichment_pages, website_delay, cancellation_token)
        representative = _best_result(bucket.results)
        combined_text = " ".join(
            [metadata.page_text, representative.title, representative.description, representative.url]
        )
        decision = classify_store_candidate(representative, combined_text)
        store_name = metadata.store_name or _title_fallback(representative, bucket.domain)
        audit_record = CandidateAuditRecord(
            canonical_domain=bucket.domain,
            website_url=final_url or bucket.homepage,
            store_name=store_name,
            accepted=decision.accepted,
            confidence=decision.confidence,
            reasons=list(decision.reasons),
            source_queries=sorted(bucket.queries),
            title=representative.title,
            description=representative.description,
        )
        audit_records.append(audit_record)
        if not decision.accepted and not include_low_confidence:
            continue

        store_record = StoreRecord(
            store_name=store_name,
            canonical_domain=bucket.domain,
            website_url=final_url or bucket.homepage,
            instagram_url=metadata.instagram_url,
            facebook_url=metadata.facebook_url,
            city=metadata.city,
            state=metadata.state,
            country="Mexico",
            store_logo=metadata.store_logo,
            status="ACCEPTED" if decision.accepted else "REJECTED",
            confidence=decision.confidence,
            source_queries=sorted(bucket.queries),
            evidence=list(decision.reasons),
        )
        records.append(store_record)
        if discovery_repository is not None:
            discovery_repository.upsert_store_candidate(store_record)
    return records, audit_records


def _enrich_site(
    homepage: str,
    max_enrichment_pages: int,
    website_delay: float,
    cancellation_token: CancellationToken | None = None,
) -> tuple[SiteMetadata, str]:
    raise_if_cancelled(cancellation_token)
    fetched = fetch_html(homepage)
    if fetched is None:
        return SiteMetadata(), homepage

    metadata = extract_site_metadata(fetched.text, fetched.url)
    final_url = fetched.url
    for link in metadata.internal_links[:max_enrichment_pages]:
        raise_if_cancelled(cancellation_token)
        time.sleep(website_delay)
        raise_if_cancelled(cancellation_token)
        extra = fetch_html(link)
        if extra is None:
            continue
        metadata = merge_metadata(metadata, extract_site_metadata(extra.text, extra.url))
    return metadata, final_url


def _best_result(results: list[SearchResult]) -> SearchResult:
    return sorted(results, key=lambda result: len(result.description), reverse=True)[0]


def _title_fallback(result: SearchResult, domain: str) -> str:
    title = result.title.strip()
    if title:
        for separator in (" | ", " - ", " – ", " — "):
            if separator in title:
                return title.split(separator, 1)[0].strip()
        return title
    return domain
