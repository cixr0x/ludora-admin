from __future__ import annotations


CORE_QUERIES = [
    "juegos de mesa mexico",
    "tienda juegos de mesa mexico",
    "juegos de mesa tienda online mexico",
    "comprar juegos de mesa mexico",
    "juegos de tablero tienda mexico",
    "tienda juegos de rol mexico",
    "magic the gathering tienda mexico",
    "pokemon tcg tienda mexico",
    "dungeons and dragons tienda mexico",
    "miniaturas warhammer tienda mexico",
    "ludoteca tienda juegos de mesa mexico",
    "juegos de mesa envios a todo mexico",
    "tienda online juegos de mesa modernos mexico",
    "tienda juegos de cartas y mesa mexico",
    "board games tienda mexico",
    "TCG juegos de mesa tienda mexico",
    "Warhammer juegos de mesa tienda mexico",
    'site:.mx "juegos de mesa" "carrito"',
    'site:.mx "juegos de mesa" "tienda online"',
    'site:.mx "comprar" "juegos de mesa"',
    'site:.com.mx "juegos de mesa" "agregar al carrito"',
    '"juegos de mesa" "MXN" "agregar al carrito"',
    '"juegos de tablero" "envios nacionales"',
]

KEY_CITIES = [
    "Ciudad de Mexico",
    "Guadalajara",
    "Monterrey",
    "Puebla",
    "Queretaro",
    "Merida",
    "Tijuana",
    "Leon",
    "Toluca",
    "Zapopan",
    "Cancun",
    "Aguascalientes",
]

MEXICAN_STATES = [
    "Aguascalientes",
    "Baja California",
    "Baja California Sur",
    "Campeche",
    "Chiapas",
    "Chihuahua",
    "Ciudad de Mexico",
    "Coahuila",
    "Colima",
    "Durango",
    "Estado de Mexico",
    "Guanajuato",
    "Guerrero",
    "Hidalgo",
    "Jalisco",
    "Michoacan",
    "Morelos",
    "Nayarit",
    "Nuevo Leon",
    "Oaxaca",
    "Puebla",
    "Queretaro",
    "Quintana Roo",
    "San Luis Potosi",
    "Sinaloa",
    "Sonora",
    "Tabasco",
    "Tamaulipas",
    "Tlaxcala",
    "Veracruz",
    "Yucatan",
    "Zacatecas",
]


def build_queries(scope: str = "expanded") -> list[str]:
    if scope not in {"core", "expanded", "full"}:
        raise ValueError("scope must be one of: core, expanded, full")

    queries = list(CORE_QUERIES)

    if scope in {"expanded", "full"}:
        for city in KEY_CITIES:
            queries.append(f"tienda juegos de mesa {city} mexico")
            queries.append(f"juegos de mesa tienda online {city}")

    if scope == "full":
        for state in MEXICAN_STATES:
            queries.append(f"tienda juegos de mesa {state} mexico")
            queries.append(f"comprar juegos de mesa {state}")

    return _dedupe_preserving_order(queries)


def _dedupe_preserving_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    deduped: list[str] = []
    for value in values:
        key = value.casefold()
        if key not in seen:
            seen.add(key)
            deduped.append(value)
    return deduped
