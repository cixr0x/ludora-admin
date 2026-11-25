from __future__ import annotations

import json
import math
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import urlparse


JUEGAMAS_STOCK_PATH = "/website_sale/get_combination_info"


def is_juegamas_product_url(url: str) -> bool:
    parsed = urlparse(url)
    return (
        parsed.scheme in {"http", "https"}
        and parsed.hostname in {"juegamas.mx", "www.juegamas.mx"}
        and parsed.path.startswith("/shop/")
    )


@dataclass(frozen=True)
class JuegaMasProductSelection:
    product_id: int
    product_template_id: int
    combination: tuple[int, ...]
    quantity: int

    def request_data(self) -> bytes:
        return json.dumps({
            "jsonrpc": "2.0",
            "method": "call",
            "params": {
                "product_id": self.product_id,
                "product_template_id": self.product_template_id,
                "combination": self.combination,
                "add_qty": self.quantity,
                "parent_combination": [],
                "context": {},
            },
            "id": 1,
        }).encode("utf-8")

    def availability_from_response(self, text: str) -> str:
        try:
            payload = json.loads(text)
        except ValueError as exc:
            raise ValueError("Odoo stock response was not valid JSON") from exc
        result = payload.get("result") if isinstance(payload, dict) and "error" not in payload else None
        if not isinstance(result, dict):
            raise ValueError("Odoo stock response did not contain a result")
        if result.get("product_id") != self.product_id or result.get("product_template_id") != self.product_template_id:
            raise ValueError("Odoo stock response did not match the product selection")

        possible = result.get("is_combination_possible")
        if possible is False:
            return "out_of_stock"
        if possible is not True:
            raise ValueError("Odoo stock response did not identify a purchasable combination")

        storable = result.get("is_storable")
        backorders = result.get("allow_out_of_stock_order")
        if type(storable) is not bool or type(backorders) is not bool:
            raise ValueError("Odoo stock response did not contain the stock policy")
        if storable and not backorders:
            free_qty = _number(result.get("free_qty"))
            cart_qty = _number(result.get("cart_qty"))
            return "out_of_stock" if free_qty - cart_qty < 1 else "available"
        if result.get("product_type") == "combo" and "max_combo_quantity" in result:
            return "out_of_stock" if _number(result["max_combo_quantity"]) < 1 else "available"
        return "available"


def _number(value: object) -> int | float:
    if type(value) is int or (type(value) is float and math.isfinite(value)):
        return value
    raise ValueError("Odoo stock response did not contain valid stock quantities")


def extract_juegamas_product_selection(html: str) -> JuegaMasProductSelection:
    parser = _ProductFormParser()
    parser.feed(html)
    parser.close()
    if parser.selection is None:
        raise ValueError("Odoo product page did not expose a default product selection")
    return parser.selection


class _ProductFormParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.selection: JuegaMasProductSelection | None = None
        self.in_product_form = False
        self.main_product_depth = 0
        self.product_inputs: dict[str, str] = {}
        self.variant_values: list[str] = []
        self.in_variant_select = False
        self.first_option = ""
        self.selected_option = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self.selection is not None:
            return
        attributes = dict(attrs)
        if tag == "form":
            self.in_product_form = attributes.get("action") == "/shop/cart/update"
            self.main_product_depth = 0
            self.product_inputs = {}
            self.variant_values = []
            self.in_variant_select = False
        if not self.in_product_form:
            return

        classes = (attributes.get("class") or "").split()
        if tag == "div" and (self.main_product_depth or "js_main_product" in classes):
            self.main_product_depth += 1
        if not self.main_product_depth:
            return

        value = attributes.get("value") or ""
        if tag == "input":
            name = attributes.get("name")
            if name in {"product_id", "product_template_id", "add_qty"} and (
                attributes.get("type") != "radio" or "checked" in attributes
            ):
                if name == "product_id" and attributes.get("type") == "radio":
                    self.product_inputs[name] = value
                else:
                    self.product_inputs.setdefault(name, value)
            if "js_variant_change" in classes and "checked" in attributes:
                self.variant_values.append(value)
        elif tag == "select" and "js_variant_change" in classes:
            self.in_variant_select = True
            self.first_option = ""
            self.selected_option = ""
        elif tag == "option" and self.in_variant_select and "disabled" not in attributes:
            if not self.first_option:
                self.first_option = value
            if "selected" in attributes:
                self.selected_option = value

    def handle_endtag(self, tag: str) -> None:
        if not self.in_product_form:
            return
        if tag == "div" and self.main_product_depth:
            self.main_product_depth -= 1
        elif tag == "select" and self.in_variant_select:
            self.in_variant_select = False
            self.variant_values.append(self.selected_option or self.first_option)
        elif tag == "form":
            self.in_product_form = False
            try:
                product_id = int(self.product_inputs["product_id"])
                template_id = int(self.product_inputs["product_template_id"])
                quantity = int(self.product_inputs.get("add_qty", "1"))
                combination = tuple(int(value) for value in self.variant_values)
            except (KeyError, ValueError):
                return
            if min(product_id, template_id, quantity, *combination) > 0:
                self.selection = JuegaMasProductSelection(product_id, template_id, combination, quantity)
