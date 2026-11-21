BEGIN;

UPDATE public.events
SET link = 'https://rollagame.com/?utm_source=ludoradar.mx&utm_medium=referral&utm_campaign=roll_a_game_2026&utm_content=homepage_banner'
WHERE id = 1
  AND name = 'Roll a Game 2026 | Expo de Juegos de Mesa en CDMX'
  AND link = 'https://rollagame.com/'
RETURNING id, name, link;

COMMIT;
