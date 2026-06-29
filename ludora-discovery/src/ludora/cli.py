from __future__ import annotations

import argparse
import os
import sys

from ludora.brave import BraveApiError
from ludora.collector import collect_stores
from ludora.config import resolve_brave_api_key, resolve_database_url
from ludora.database import DiscoveryRepository, connect_database
from ludora.inventory import collect_store_inventory
from ludora.queries import build_queries


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Collect Mexican online boardgame stores using Brave Search API.",
    )
    parser.add_argument("--api-key", default=None)
    parser.add_argument("--env-file", default=".env", help="Path to a .env file with BRAVE_SEARCH_API_KEY.")
    parser.add_argument("--output-dir", default="data")
    parser.add_argument("--query-scope", choices=["core", "expanded", "full"], default="expanded")
    parser.add_argument("--max-queries", type=int, default=None)
    parser.add_argument("--count", type=int, default=20, help="Brave results per query.")
    parser.add_argument("--pages", type=int, default=1, help="Brave result pages per query.")
    parser.add_argument("--request-delay", type=float, default=1.1, help="Delay between Brave requests.")
    parser.add_argument("--website-delay", type=float, default=0.3, help="Delay between website enrichment requests.")
    parser.add_argument("--max-enrichment-pages", type=int, default=3)
    parser.add_argument("--include-low-confidence", action="store_true")
    parser.add_argument("--database-url", default=None, help="Postgres connection URL for dirty discovery persistence.")
    parser.add_argument(
        "--persist-discovery",
        action="store_true",
        help="Deprecated compatibility flag; discovery persistence is now the default.",
    )
    parser.add_argument("--export-files", action="store_true", help="Also export CSV/JSON files to --output-dir.")
    parser.add_argument(
        "--collect-listings",
        action="store_true",
        help="Fetch accepted store homepages and persist raw item candidates.",
    )
    parser.add_argument(
        "--listing-limit",
        type=int,
        default=None,
        help="Maximum item candidates to extract per store. Defaults to no limit.",
    )
    parser.add_argument("--dry-run-queries", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    queries = build_queries(args.query_scope)
    if args.max_queries is not None:
        queries = queries[: args.max_queries]

    if args.dry_run_queries:
        for query in queries:
            print(query)
        return 0

    api_key = resolve_brave_api_key(args.api_key, env=os.environ, dotenv_path=args.env_file)
    if not api_key:
        print(
            "Missing Brave API key. Add BRAVE_SEARCH_API_KEY to .env, set the environment variable, or pass --api-key.",
            file=sys.stderr,
        )
        return 2

    database_url = resolve_database_url(args.database_url, env=os.environ, dotenv_path=args.env_file)
    discovery_repository = None
    database_connection = None
    if not database_url:
        print(
            "Missing database URL. Add LUDORA_DATABASE_URL to .env, set the environment variable, or pass --database-url.",
            file=sys.stderr,
        )
        return 2
    try:
        database_connection = connect_database(database_url)
        discovery_repository = DiscoveryRepository(database_connection)
    except Exception as exc:
        print(f"Database connection failed: {exc}", file=sys.stderr)
        return 1

    try:
        summary = collect_stores(
            api_key=api_key,
            output_dir=args.output_dir,
            query_scope=args.query_scope,
            max_queries=args.max_queries,
            count=args.count,
            pages=args.pages,
            request_delay=args.request_delay,
            website_delay=args.website_delay,
            max_enrichment_pages=args.max_enrichment_pages,
            include_low_confidence=args.include_low_confidence,
            verbose=args.verbose,
            discovery_repository=discovery_repository,
            export_files=args.export_files,
        )
    except BraveApiError as exc:
        if database_connection is not None:
            database_connection.close()
        print(str(exc), file=sys.stderr)
        return 1

    print(f"Searched queries: {summary.searched_queries}")
    print(f"Candidate domains: {summary.candidate_domains}")
    print(f"Accepted stores: {len(summary.records)}")
    print("Database: discovery_store_candidates")
    if summary.csv_path is not None:
        print(f"CSV: {summary.csv_path}")
    if summary.json_path is not None:
        print(f"JSON: {summary.json_path}")
    if summary.audit_csv_path is not None:
        print(f"Audit CSV: {summary.audit_csv_path}")
    if summary.audit_json_path is not None:
        print(f"Audit JSON: {summary.audit_json_path}")
    if args.collect_listings and discovery_repository is not None:
        listing_count = 0
        for record in summary.records:
            listing_count += len(
                collect_store_inventory(
                    record.website_url,
                    None,
                    discovery_repository,
                    limit=args.listing_limit,
                )
            )
        print(f"Item candidates: {listing_count}")

    if database_connection is not None:
        database_connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
