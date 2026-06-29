import sys
import tempfile
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ludora.export import write_audit_outputs
from ludora.models import CandidateAuditRecord


class ExportTests(unittest.TestCase):
    def test_write_audit_outputs_writes_rejected_candidate_reasons(self):
        audit_record = CandidateAuditRecord(
            canonical_domain="example.mx",
            website_url="https://example.mx/",
            store_name="Example",
            accepted=False,
            confidence=0.49,
            reasons=["boardgame", "missing_online_store", "mexico"],
            source_queries=["juegos de mesa mexico"],
            title="Example juegos de mesa",
            description="Resenas y noticias.",
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            csv_path, json_path = write_audit_outputs([audit_record], temp_dir)
            csv_text = csv_path.read_text(encoding="utf-8")
            json_text = json_path.read_text(encoding="utf-8")

        self.assertIn("example.mx", csv_text)
        self.assertIn("missing_online_store", csv_text)
        self.assertIn('"accepted": "False"', json_text)


if __name__ == "__main__":
    unittest.main()
