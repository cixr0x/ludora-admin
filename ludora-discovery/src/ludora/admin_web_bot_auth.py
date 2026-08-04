from __future__ import annotations

import json
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen


class AdminWebBotAuthHeadersProvider:
    def __init__(
        self,
        admin_api_url: str,
        *,
        internal_api_token: str,
        timeout_seconds: int = 10,
    ) -> None:
        self.admin_api_url = admin_api_url.rstrip("/")
        self.internal_api_token = internal_api_token.strip()
        self.timeout_seconds = timeout_seconds

    def headers_for(self, target_url: str, method: str = "GET") -> dict[str, str]:
        if not self.admin_api_url:
            raise RuntimeError("Admin API URL is required for Web Bot Auth")
        if not self.internal_api_token:
            raise RuntimeError("Internal API token is required for Web Bot Auth")

        request = Request(
            urljoin(f"{self.admin_api_url}/", "admin/web-bot-auth/signatures"),
            data=json.dumps({"url": target_url, "method": method}).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Ludora-Internal-Token": self.internal_api_token,
            },
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            raise RuntimeError(f"Admin Web Bot Auth signer returned HTTP {exc.code}") from exc
        except (URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"Admin Web Bot Auth signer failed: {exc}") from exc

        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, dict):
            raise RuntimeError("Admin Web Bot Auth signer returned an invalid response")
        signature_agent = str(data.get("signature_agent", "")).strip()
        signature_input = str(data.get("signature_input", "")).strip()
        signature = str(data.get("signature", "")).strip()
        if not signature_agent or not signature_input or not signature:
            raise RuntimeError("Admin Web Bot Auth signer returned incomplete headers")
        return {
            "Signature-Agent": signature_agent,
            "Signature-Input": signature_input,
            "Signature": signature,
        }
