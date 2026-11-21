BEGIN;

INSERT INTO public.events (
    name, description, starts_at, ends_at,
    min_price, max_price, country, city, venue, link, time_zone
) VALUES (
    'Roll a Game 2026 | Expo de Juegos de Mesa en CDMX',
    'Expo de juegos de mesa, cartas coleccionables y juegos de rol, con mesas de juego, demostraciones y actividades para toda la familia.',
    TIMESTAMPTZ '2026-11-28 11:00:00 America/Mexico_City',
    TIMESTAMPTZ '2026-11-29 18:00:00 America/Mexico_City',
    270.00,
    495.00,
    'México',
    'Ciudad de México',
    'Centro Banamex, Sala B',
    'https://rollagame.com/',
    'America/Mexico_City'
)
RETURNING id, name;

COMMIT;
