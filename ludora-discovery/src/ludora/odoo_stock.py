from __future__ import annotations

import json
import math
from dataclasses import dataclass
from html.parser import HTMLParser


ODOO_COMBINATION_PATH = "/website_sale/get_combination_info"
LEGACY_ODOO_COMBINATION_PATH = "/sale/get_combination_info_website"
INVENTORY_FIELDS = frozenset({
    "allow_out_of_stock_order", "free_qty", "cart_qty",
    "show_availability", "available_threshold", "out_of_stock_message",
})
LEGACY_STORABLE_TYPES = {"product": True, "consu": False, "service": False, "combo": False}


@dataclass(frozen=True)
class OdooProductSelection:
    product_id: int
    product_template_id: int
    combination: tuple[int, ...]
    quantity: int

    def request_data(self, *, legacy: bool) -> bytes:
        params = {
            "product_id": self.product_id,
            "product_template_id": self.product_template_id,
            "combination": self.combination,
            "add_qty": self.quantity,
            "parent_combination": [],
            "context": {},
        }
        if legacy:
            params["pricelist_id"] = False
        return json.dumps({"jsonrpc": "2.0", "method": "call", "params": params, "id": 1}).encode("utf-8")

    def availability_from_response(self, text: str) -> str | None:
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

        if "max_combo_quantity" in result:
            return "out_of_stock" if _number(result["max_combo_quantity"]) < 1 else "available"
        if not INVENTORY_FIELDS.intersection(result):
            return None

        storable = result.get("is_storable")
        if "is_storable" not in result:
            storable = LEGACY_STORABLE_TYPES.get(str(result.get("product_type")))
        backorders = result.get("allow_out_of_stock_order")
        if type(storable) is not bool or type(backorders) is not bool:
            raise ValueError("Odoo stock response did not contain the stock policy")
        if storable and not backorders:
            free_qty = _number(result.get("free_qty"))
            cart_qty = _number(result.get("cart_qty"))
            return "out_of_stock" if free_qty - cart_qty < 1 else "available"
        return "available"


def _number(value: object) -> int | float:
    if type(value) is int or (type(value) is float and math.isfinite(value)):
        return value
    raise ValueError("Odoo stock response did not contain valid stock quantities")


@dataclass(frozen=True)
class OdooStockPage:
    selection: OdooProductSelection | None
    advertises_stock: bool
    legacy_frontend: bool

    @property
    def combination_paths(self) -> tuple[str, str]:
        if self.legacy_frontend:
            return LEGACY_ODOO_COMBINATION_PATH, ODOO_COMBINATION_PATH
        return ODOO_COMBINATION_PATH, LEGACY_ODOO_COMBINATION_PATH


def inspect_odoo_stock_page(html: str) -> OdooStockPage:
    parser = _ProductFormParser()
    parser.feed(html)
    parser.close()
    return OdooStockPage(parser.selection, parser.advertises_stock, parser.legacy_frontend)


class _ProductFormParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.selection: OdooProductSelection | None = None
        self.advertises_stock = False
        self.legacy_frontend = False
        self.main_product_depth = 0
        self.product_inputs: dict[str, str] = {}
        self.variant_values: list[str] = []
        self.in_variant_select = False
        self.first_option = ""
        self.selected_option = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        classes = (attributes.get("class") or "").split()
        if "availability_messages" in classes:
            self.advertises_stock = True
        if tag == "script" and (
            attributes.get("data-asset-bundle") == "web.assets_frontend_lazy"
            and attributes.get("data-asset-version")
        ):
            self.legacy_frontend = True
        if self.selection is not None:
            return

        if tag == "div":
            if self.main_product_depth:
                self.main_product_depth += 1
            elif {"js_main_product", "main_product"}.intersection(classes):
                self.main_product_depth = 1
                self.product_inputs = {}
                self.variant_values = []
                self.in_variant_select = False
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
        if not self.main_product_depth:
            return
        if tag == "div":
            self.main_product_depth -= 1
            if self.main_product_depth == 0:
                self.selection = self._product_selection()
        elif tag == "select" and self.in_variant_select:
            self.in_variant_select = False
            self.variant_values.append(self.selected_option or self.first_option)

    def _product_selection(self) -> OdooProductSelection | None:
        try:
            product_id = int(self.product_inputs["product_id"])
            template_id = int(self.product_inputs["product_template_id"])
            quantity = int(self.product_inputs.get("add_qty", "1"))
            combination = tuple(int(value) for value in self.variant_values)
        except (KeyError, ValueError):
            return None
        if min(product_id, template_id, quantity, *combination) <= 0:
            return None
        return OdooProductSelection(product_id, template_id, combination, quantity)
